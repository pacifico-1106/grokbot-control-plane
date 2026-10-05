/**
 * One shared join → proposal flow for Slack, LINE and Telegram (PR-B).
 * Every channel's join event maps into handleChannelJoin; tickets are
 * channels.classify (+ parties.upsert for mixed Slack channels), admin class,
 * always_human, never applied without a human approval.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { getApprovalById, listApprovals } from "@/lib/data";
import { resolveApprovalWithoutWorkflow } from "@/lib/data/approvals";
import { getOrgChannel, upsertOrgChannel } from "@/lib/data/directory";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import {
  handleChannelJoin,
  lineJoinSignal,
  setJoinDepsForTests,
  slackJoinSignals,
  telegramJoinSignal,
} from "@/lib/channel-classify/join";
import { setChannelFactsDepsForTests, type SlackApi } from "@/lib/channel-classify/facts";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import type { ApprovalRequest } from "@/lib/types";

const ORG = DEMO_ORG.id;
const OTHER_ORG = "org_other_tenant_fixture";
const HOME_TEAM = "T0HOMETEAM";
const notified: string[] = [];
let extShared = false;
let guestIds: string[] = [];
let externalIds: string[] = [];
let channelCounter = 0;

function channelId(): string {
  channelCounter += 1;
  return `C0JOIN${String(channelCounter).padStart(4, "0")}`;
}

const fakeSlack: SlackApi = async (method, params) => {
  if (method === "conversations.info") {
    return {
      ok: true,
      channel: {
        id: params.channel,
        is_channel: true,
        is_private: false,
        is_shared: extShared,
        is_ext_shared: extShared,
        is_im: false,
        is_mpim: false,
        num_members: 2 + guestIds.length + externalIds.length,
      },
    };
  }
  if (method === "conversations.members") {
    return { ok: true, members: ["U0EMPLOYEE", "U0COLLEAGUE", ...guestIds, ...externalIds], response_metadata: { next_cursor: "" } };
  }
  if (method === "users.info") {
    const id = params.user;
    if (externalIds.includes(id)) return { ok: true, user: { id, team_id: "T0OTHERCORP", is_restricted: false } };
    if (guestIds.includes(id)) return { ok: true, user: { id, team_id: HOME_TEAM, is_restricted: true } };
    return { ok: true, user: { id, team_id: HOME_TEAM, is_restricted: false, is_ultra_restricted: false } };
  }
  return { ok: false, error: "unknown_method" };
};

function proposalApprovals(all: ApprovalRequest[], externalId: string): ApprovalRequest[] {
  return all.filter((row) => {
    const meta = row.metadata?.channelClassifyProposal as { externalId?: string } | undefined;
    return meta?.externalId === externalId;
  });
}

beforeEach(() => {
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
  extShared = false;
  guestIds = [];
  externalIds = [];
  notified.length = 0;
  resetDemoChannelClassifyStore();
  setChannelFactsDepsForTests({ slackApi: fakeSlack, resolveToken: async () => "xoxb-fixture" });
  setProposalDepsForTests({ notifyApproval: async (approval) => { notified.push(approval.id); return true; } });
  setJoinDepsForTests({
    findEmployeeOrgsBySlackUser: async (userId, teamId) =>
      userId === "U0EMPLOYEE" && teamId === HOME_TEAM ? [{ orgId: ORG, employeeId: "emp_comm" }] : [],
    findOrgsBySlackTeam: async (teamId) => (teamId === HOME_TEAM ? [ORG] : []),
  });
});

afterEach(() => {
  delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
  setChannelFactsDepsForTests(null);
  setProposalDepsForTests(null);
  setJoinDepsForTests(null);
});

function slackEnvelope(channel: string, user = "U0EMPLOYEE", extra: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: HOME_TEAM,
    event_id: `Ev${channel}`,
    authorizations: [{ team_id: HOME_TEAM, user_id: "U0APPBOT", is_bot: true }],
    event: { type: "member_joined_channel", user, channel, channel_type: "C", team: HOME_TEAM, ...extra },
  };
}

describe("Slack join → proposal", () => {
  test("employee joins an internal channel → one channels.classify ticket (internal), admin class, always_human, not applied", async () => {
    const channel = channelId();
    const signals = await slackJoinSignals(slackEnvelope(channel));
    expect(signals.length).toBe(1);
    expect(signals[0]).toMatchObject({ orgId: ORG, surface: "slack", externalId: channel, trigger: "slack_member_joined" });
    const outcome = await handleChannelJoin(signals[0]);
    expect(outcome.state).toBe("created");
    const approval = await getApprovalById(outcome.approvalId!, ORG);
    expect(approval?.status).toBe("pending");
    expect(approval?.tool).toBe("channels.classify");
    expect(approval?.metadata?.approvalClass).toBe("admin");
    expect(approval?.metadata?.always_human).toBe(true);
    expect(approval?.metadata?.adminTool).toBe("channels.classify");
    expect(approval?.metadata?.adminMutation).toEqual({ surface: "slack", externalId: channel, classification: "internal", mixed: false });
    expect(String(approval?.summary)).toContain(channel);
    expect(notified).toContain(outcome.approvalId!);
    // never applied automatically
    expect(await getOrgChannel(ORG, "slack", channel)).toBeNull();
  });

  test("the org's own bot joining (authorizations is_bot) resolves the org by team", async () => {
    const channel = channelId();
    const signals = await slackJoinSignals(slackEnvelope(channel, "U0APPBOT"));
    expect(signals.map((s) => s.orgId)).toEqual([ORG]);
  });

  test("a non-employee joining does not propose anything", async () => {
    expect(await slackJoinSignals(slackEnvelope(channelId(), "U0SOMEONE"))).toEqual([]);
  });

  test("Slack Connect channel with guests → shared_external mixed + parties.upsert for internal members", async () => {
    extShared = true;
    guestIds = ["U0GUEST1"];
    externalIds = ["U0PARTNER1"];
    const channel = channelId();
    const [signal] = await slackJoinSignals(slackEnvelope(channel));
    const outcome = await handleChannelJoin(signal);
    expect(outcome.state).toBe("created");
    const approval = await getApprovalById(outcome.approvalId!, ORG);
    expect(approval?.metadata?.adminMutation).toMatchObject({ classification: "shared_external", mixed: true });
    expect(String(approval?.summary)).toContain("Slack Connect");
    expect(outcome.partyApprovalIds?.length).toBeGreaterThan(0);
    const party = await getApprovalById(outcome.partyApprovalIds![0], ORG);
    expect(party?.tool).toBe("parties.upsert");
    expect(party?.metadata?.always_human).toBe(true);
    expect((party?.metadata?.adminMutation as { kind?: string }).kind).toBe("slack_user");
  });
});

describe("LINE join → proposal", () => {
  test("bot added to a LINE group → channels.classify (line, shared_external mixed, unverified)", async () => {
    const signal = lineJoinSignal({ orgId: ORG }, { type: "join", source: { type: "group", groupId: "Cfixturegroup0001" } });
    expect(signal).toMatchObject({ orgId: ORG, surface: "line", externalId: "Cfixturegroup0001", trigger: "line_join" });
    const outcome = await handleChannelJoin(signal!);
    expect(outcome.state).toBe("created");
    const approval = await getApprovalById(outcome.approvalId!, ORG);
    expect(approval?.metadata?.adminMutation).toEqual({ surface: "line", externalId: "Cfixturegroup0001", classification: "shared_external", mixed: true });
    expect(approval?.metadata?.always_human).toBe(true);
  });

  test("LINE room join maps too; a 1:1 follow / message event does not", () => {
    expect(lineJoinSignal({ orgId: ORG }, { type: "join", source: { type: "room", roomId: "Rfixtureroom0001" } })?.externalId).toBe("Rfixtureroom0001");
    expect(lineJoinSignal({ orgId: ORG }, { type: "follow", source: { type: "user", userId: "U1" } })).toBeNull();
    expect(lineJoinSignal({ orgId: ORG }, { type: "message", source: { type: "group", groupId: "C1" } })).toBeNull();
  });
});

describe("Telegram join → proposal", () => {
  test("bot added to a group (my_chat_member left → member) → channels.classify (telegram)", async () => {
    const signal = telegramJoinSignal({ orgId: ORG }, {
      my_chat_member: {
        chat: { id: -1001234567890, type: "supergroup" },
        old_chat_member: { status: "left", user: { id: 42, is_bot: true } },
        new_chat_member: { status: "member", user: { id: 42, is_bot: true } },
      },
    });
    expect(signal).toMatchObject({ orgId: ORG, surface: "telegram", externalId: "-1001234567890", trigger: "telegram_my_chat_member" });
    const outcome = await handleChannelJoin(signal!);
    expect(outcome.state).toBe("created");
    const approval = await getApprovalById(outcome.approvalId!, ORG);
    expect(approval?.metadata?.adminMutation).toMatchObject({ surface: "telegram", externalId: "-1001234567890", classification: "shared_external" });
  });

  test("private chats and leave events are ignored", () => {
    expect(telegramJoinSignal({ orgId: ORG }, { my_chat_member: { chat: { id: 5, type: "private" }, new_chat_member: { status: "member", user: { id: 42, is_bot: true } } } })).toBeNull();
    expect(telegramJoinSignal({ orgId: ORG }, { my_chat_member: { chat: { id: -5, type: "group" }, old_chat_member: { status: "member" }, new_chat_member: { status: "left", user: { id: 42, is_bot: true } } } })).toBeNull();
  });
});

describe("dedupe, flag, isolation, fail-closed", () => {
  test("one open ticket per channel; no reopen after rejection unless facts change", async () => {
    const channel = channelId();
    const [signal] = await slackJoinSignals(slackEnvelope(channel));
    const first = await handleChannelJoin(signal);
    expect(first.state).toBe("created");
    const again = await handleChannelJoin(signal);
    expect(again).toMatchObject({ state: "pending", approvalId: first.approvalId });
    expect(proposalApprovals(await listApprovals(ORG), channel).length).toBe(1);

    await resolveApprovalWithoutWorkflow(first.approvalId!, "rejected", "fixture-human", ORG);
    const afterReject = await handleChannelJoin(signal);
    expect(afterReject.state).toBe("decided");
    expect(proposalApprovals(await listApprovals(ORG), channel).length).toBe(1);

    extShared = true; // facts changed (now Slack Connect)
    const changed = await handleChannelJoin(signal);
    expect(changed.state).toBe("created");
    expect(changed.approvalId).not.toBe(first.approvalId);
  });

  test("flag OFF → nothing is proposed", async () => {
    delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
    const channel = channelId();
    const [signal] = await slackJoinSignals(slackEnvelope(channel));
    expect((await handleChannelJoin(signal)).state).toBe("flag_off");
    expect(proposalApprovals(await listApprovals(ORG), channel).length).toBe(0);
  });

  test("already registered channel → no ticket", async () => {
    const channel = channelId();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    const [signal] = await slackJoinSignals(slackEnvelope(channel));
    expect((await handleChannelJoin(signal)).state).toBe("registered");
  });

  test("dedupe is per org: another tenant's pending ticket for the same id never blocks / leaks", async () => {
    const outcomeA = await handleChannelJoin({ orgId: ORG, surface: "line", externalId: "Csharedid0001", trigger: "line_join" });
    const outcomeB = await handleChannelJoin({ orgId: OTHER_ORG, surface: "line", externalId: "Csharedid0001", trigger: "line_join" });
    expect(outcomeA.state).toBe("created");
    expect(outcomeB.state).toBe("created");
    expect(outcomeB.approvalId).not.toBe(outcomeA.approvalId);
    expect(await getApprovalById(outcomeB.approvalId!, ORG)).toBeNull();
  });

  test("ticket creation failure → error outcome, claim released (next join can propose)", async () => {
    setProposalDepsForTests({
      notifyApproval: async () => true,
      createApproval: async () => { throw new Error("store_down"); },
    });
    const signal = { orgId: ORG, surface: "telegram" as const, externalId: "-1009999", trigger: "telegram_my_chat_member" as const };
    const failed = await handleChannelJoin(signal);
    expect(failed.state).toBe("error");
    setProposalDepsForTests({ notifyApproval: async () => true });
    expect((await handleChannelJoin(signal)).state).toBe("created");
  });
});
