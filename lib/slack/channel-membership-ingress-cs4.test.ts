import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { listAuditEvents } from "@/lib/data";
import { upsertNotificationChannel, resetDemoNotificationChannels } from "@/lib/data/notification-channels";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import { upsertOrgChannel } from "@/lib/data/directory";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { processSlackMentionEnvelope } from "@/lib/slack/mention-ingress";
import { buildConnectInviteCardText } from "@/lib/channel-scope/notify";
import {
  __resetChannelScopeDemoStore,
  listEmployeeChannelMemberships,
  setOrgChannelScopePolicy,
  upsertEmployeeChannelMembership,
} from "@/lib/channel-scope/data";
import { defaultChannelScopePolicy } from "@/lib/channel-scope/validate";
import type { ChannelScopePolicy } from "@/lib/channel-scope/types";

const ORG = DEMO_ORG.id;
const ME = "U0INAMORI";
const HOME = "T0SPACE";
const PEER = "T0PEER";
const INVITER = "U0PEERGUEST";
const INBOX = "C0APPROVERS";
const saved = { scope: process.env.P1_CHANNEL_SCOPE_ENABLED, connect: process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED };
const savedFetch = globalThis.fetch;
let seq = 0;
let info: Record<string, Record<string, unknown> | null> = {};
let users: Record<string, string> = {};
let posts: { channel: string; text: string; blocks?: unknown }[] = [];
let userInfoCalls = 0;
let employeeId = "";
let restoreAllowed: (() => void) | null = null;

const evId = (t: string) => `Ev0CS4${t}${Date.now()}${(seq += 1)}`;
const chan = () => `C0CS4${Date.now().toString(36).toUpperCase()}${(seq += 1)}`;
const policy = (
  p: Omit<Partial<ChannelScopePolicy>, "connect"> & { connect?: Partial<ChannelScopePolicy["connect"]> }
): ChannelScopePolicy => ({
  ...defaultChannelScopePolicy(),
  ...p,
  connect: { ...defaultChannelScopePolicy().connect, ...(p.connect ?? {}) },
});
const connectInfo = { is_ext_shared: true, is_shared: true, context_team_id: HOME, connected_team_ids: [HOME, PEER] };
const internalInfo = { is_ext_shared: false, is_shared: false, context_team_id: HOME };

function join(channel: string, inviter = INVITER, eventId = evId("join")) {
  return processSlackMentionEnvelope({
    type: "event_callback",
    team_id: HOME,
    event_id: eventId,
    authorizations: [{ is_bot: false, user_id: ME, team_id: HOME }],
    event: { type: "member_joined_channel", user: ME, channel, channel_type: "C", team: HOME, inviter } as never,
  });
}

beforeEach(async () => {
  process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
  __resetChannelScopeDemoStore();
  info = { [INBOX]: { is_ext_shared: false, is_shared: false, context_team_id: HOME } };
  users = { [INVITER]: PEER, U0COLLEAGUE: HOME };
  posts = [];
  userInfoCalls = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://slack.com/api/conversations.info")) {
      const id = new URL(url).searchParams.get("channel") || "";
      const c = info[id];
      return new Response(JSON.stringify(c ? { ok: true, channel: c } : { ok: false, error: "channel_not_found" }));
    }
    if (url.startsWith("https://slack.com/api/users.info")) {
      userInfoCalls += 1;
      const id = new URL(url).searchParams.get("user") || "";
      return new Response(JSON.stringify(users[id] ? { ok: true, user: { id, team_id: users[id] } } : { ok: false, error: "user_not_found" }));
    }
    if (url.startsWith("https://slack.com/api/chat.postMessage")) {
      const body = JSON.parse(String(init?.body || "{}"));
      posts.push({ channel: body.channel, text: body.text, blocks: body.blocks });
      return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: body.channel }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;

  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
  if (!emp) throw new Error("missing emp_comm");
  employeeId = emp.id;
  const prev = { accounts: emp.allowedAccounts, channel: emp.approvalChannelId };
  emp.allowedAccounts = [{ service: "slack", accountId: ME }];
  restoreAllowed = () => {
    emp.allowedAccounts = prev.accounts;
    emp.approvalChannelId = prev.channel;
  };
  await revokeEmployeeSlackIdentity({ employeeId, orgId: ORG });
  await bindEmployeeSlackIdentity({ employeeId, orgId: ORG, slackUserId: ME, slackTeamId: HOME, displayName: "稲盛", userToken: "xoxp-cs4-test" });
  await setOrgInternalAudienceRule(ORG, { slackTeamIds: [HOME], autoSlackTeamInternal: true }, "test");
  resetDemoNotificationChannels(ORG);
  const inbox = await upsertNotificationChannel({
    orgId: ORG,
    provider: "slack",
    enabled: true,
    label: "承認者",
    config: { channelId: INBOX, allowedUserIds: ["U0OWNER"] },
    secrets: { botToken: "xoxb-cs4-inbox", signingSecret: "s" },
  });
  emp.approvalChannelId = inbox.id;
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  await revokeEmployeeSlackIdentity({ employeeId, orgId: ORG });
  restoreAllowed?.();
  clearDemoRule();
  resetDemoNotificationChannels(ORG);
});

afterAll(() => {
  if (saved.scope === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_ENABLED = saved.scope;
  if (saved.connect === undefined) delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = saved.connect;
});

const membership = async (c: string) => (await listEmployeeChannelMemberships(ORG, { employeeId, externalId: c }))[0];

describe("inviter team via users.info", () => {
  test("stored on the membership and in the audit (external inviter)", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    info[c] = connectInfo;
    await join(c);
    expect(userInfoCalls).toBe(1);
    expect(await membership(c)).toMatchObject({ inviterSlackUserId: INVITER, inviterTeamId: PEER });
    const audit = (await listAuditEvents(ORG, 40)).find((a) => a.action === "channel_scope.auto_classified" && a.metadata?.channelId === c);
    expect(audit?.metadata).toMatchObject({ inviterTeamId: PEER, inviterExternal: true });
  });

  test("internal inviter ⇒ inviterExternal=false; users.info failure ⇒ null (no crash)", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c1 = chan();
    info[c1] = internalInfo;
    await join(c1, "U0COLLEAGUE");
    expect((await membership(c1)).inviterTeamId).toBe(HOME);
    const c2 = chan();
    info[c2] = internalInfo;
    await join(c2, "U0UNKNOWNX");
    expect(await membership(c2)).toMatchObject({ state: "member", inviterTeamId: null });
  });

  test("registered_only makes no Slack API calls at all", async () => {
    const c = chan();
    info[c] = connectInfo;
    await join(c);
    expect(userInfoCalls).toBe(0);
    expect(posts).toEqual([]);
    expect((await membership(c)).state).toBe("out_of_scope");
  });
});

describe("approver info card", () => {
  test("Connect invite ⇒ one text-only card in the approver inbox (no buttons)", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    info[c] = connectInfo;
    const id = evId("card");
    await join(c, INVITER, id);
    await join(c, INVITER, id); // replay
    expect(posts.length).toBe(1);
    expect(posts[0].channel).toBe(INBOX);
    expect(posts[0].blocks).toBeUndefined();
    expect(posts[0].text).toContain(c);
    expect(posts[0].text).toContain(PEER);
    expect(posts[0].text).toContain(`${INVITER}（team ${PEER}）`);
    expect(posts[0].text).toContain("対象外"); // includeSlackConnect=false ⇒ out of scope wording
    const audits = await listAuditEvents(ORG, 40);
    expect(audits.some((a) => a.action === "channel_scope.connect_invite_notified" && a.metadata?.channelId === c)).toBe(true);
  });

  test("in-scope Connect (Connect flag ON) ⇒ wording says sends need approval", async () => {
    process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = "1";
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined", includeSlackConnect: true }));
    const c = chan();
    info[c] = connectInfo;
    await join(c);
    expect(posts.length).toBe(1);
    expect(posts[0].text).toContain("承認制");
  });

  test("no card for internal channels or when notifyApproverOnInvite=false", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c1 = chan();
    info[c1] = internalInfo;
    await join(c1);
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined", connect: { notifyApproverOnInvite: false } }));
    const c2 = chan();
    info[c2] = connectInfo;
    await join(c2);
    expect(posts).toEqual([]);
  });

  test("never delivered into a shared inbox or the Connect channel itself", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    info[INBOX] = connectInfo; // the approver inbox itself is a Connect channel
    const c = chan();
    info[c] = connectInfo;
    await join(c);
    expect(posts).toEqual([]);
    const skipped = (await listAuditEvents(ORG, 40)).find((a) => a.action === "channel_scope.connect_invite_notify_skipped" && a.metadata?.channelId === c);
    expect(String(skipped?.metadata?.reason)).toContain("inbox_shared");

    info[INBOX] = connectInfo;
    await join(INBOX);
    expect(posts).toEqual([]);
  });

  test("channel_shared later ⇒ card with 'shared' wording", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "internal", skipInspect: true });
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId, externalId: c, via: "user", state: "member" });
    await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: HOME,
      event_id: evId("shared"),
      authorizations: [{ is_bot: false, user_id: ME, team_id: HOME }],
      event: { type: "channel_shared", channel: c, connected_team_id: PEER } as never,
    });
    expect(posts.length).toBe(1);
    expect(posts[0].text).toContain("外部と共有されました");
  });

  test("card text builder never includes tokens and handles missing inviter team", () => {
    const text = buildConnectInviteCardText({
      orgId: ORG,
      employee: { id: "e", displayName: "稲盛" },
      channelId: "C0X",
      externalTeamIds: [],
      inviterSlackUserId: "U0A",
      inviterTeamId: null,
      inScope: true,
      kind: "invited",
      eventId: "Ev",
    });
    expect(text).toContain("相手 team: 不明");
    expect(text).toContain("U0A（team 不明）");
    expect(text).not.toContain("xox");
  });
});
