/**
 * Follow-up to PR-B (木村 2026-10-05, H1): per-org hourly caps on join-event
 * proposals and stuck notices. Over the cap → ONE summary notice per window,
 * then nothing. Telegram: the person who added the bot (my_chat_member.from)
 * must be a known member of the org.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { createApproval } from "@/lib/data/approvals";
import { resetDemoChannelClassifyStore, takeChannelClassifyBudget } from "@/lib/data/channel-classify";
import { handleChannelJoin, handleTelegramMyChatMember, setJoinDepsForTests } from "@/lib/channel-classify/join";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { notifyChannelStuck, setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

const ORG = DEMO_ORG.id;
const OTHER_ORG = "org_other_tenant_fixture";
let sent: string[] = [];
let audits: Array<{ orgId: string; action: string; metadata?: Record<string, unknown> }> = [];
let ticketOrgs: string[] = [];

function inbox(orgId: string): NotificationChannelRuntime {
  return { id: `nc_${orgId}`, orgId, provider: "slack", label: "x", enabled: true, isDefault: true, config: {}, secrets: {} } as unknown as NotificationChannelRuntime;
}

beforeEach(() => {
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
  process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
  sent = [];
  audits = [];
  ticketOrgs = [];
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  setProposalDepsForTests({
    notifyApproval: async () => true,
    hasApprover: async () => true,
    createApproval: async (input) => {
      ticketOrgs.push(input.orgId);
      return createApproval(input);
    },
  });
  setStuckNotifyDepsForTests({
    listChannels: async (orgId) => [inbox(orgId)],
    send: async (_channel, text) => { sent.push(text); return { ok: true }; },
    audit: async (event) => { audits.push(event); },
    mail: async () => ({ ok: true }),
  });
});

afterEach(() => {
  for (const key of [
    "CHANNEL_CLASSIFY_PROPOSALS_ENABLED",
    "CHANNEL_STUCK_NOTIFY_ENABLED",
    "CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR",
    "CHANNEL_STUCK_MAX_NOTICES_PER_HOUR",
  ]) delete process.env[key];
  setProposalDepsForTests(null);
  setStuckNotifyDepsForTests(null);
  setJoinDepsForTests(null);
});

let lineCounter = 0;
function lineSignal(orgId = ORG) {
  lineCounter += 1;
  return { orgId, surface: "line" as const, externalId: `Ccap${String(lineCounter).padStart(6, "0")}`, trigger: "line_join" as const };
}

describe("H1 data layer: takeChannelClassifyBudget (demo store mirrors the RPC)", () => {
  test("allowed up to max, then over_first once, then over; window rolls over", async () => {
    const t0 = 1_000_000;
    const take = (nowMs: number) => takeChannelClassifyBudget({ orgId: ORG, key: "proposals", windowSeconds: 3600, max: 2, nowMs });
    expect((await take(t0)).state).toBe("allowed");
    expect((await take(t0 + 1)).state).toBe("allowed");
    expect((await take(t0 + 2)).state).toBe("over_first");
    expect((await take(t0 + 3)).state).toBe("over");
    expect((await take(t0 + 3_600_000)).state).toBe("allowed");
  });

  test("per org: another org's exhausted budget never affects this org", async () => {
    for (let i = 0; i < 3; i += 1) await takeChannelClassifyBudget({ orgId: OTHER_ORG, key: "proposals", windowSeconds: 3600, max: 2 });
    expect((await takeChannelClassifyBudget({ orgId: ORG, key: "proposals", windowSeconds: 3600, max: 2 })).state).toBe("allowed");
  });

  test("bad input → denied", async () => {
    expect((await takeChannelClassifyBudget({ orgId: "", key: "proposals", windowSeconds: 3600, max: 2 })).state).toBe("denied");
    expect((await takeChannelClassifyBudget({ orgId: ORG, key: "Bad Key!", windowSeconds: 3600, max: 2 })).state).toBe("denied");
    expect((await takeChannelClassifyBudget({ orgId: ORG, key: "proposals", windowSeconds: 10, max: 2 })).state).toBe("denied");
    expect((await takeChannelClassifyBudget({ orgId: ORG, key: "proposals", windowSeconds: 3600, max: 0 })).state).toBe("denied");
  });
});

describe("H1 proposals: per-org hourly cap", () => {
  test("over the cap → rate_limited (no ticket), exactly one summary notice; claim released", async () => {
    process.env.CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR = "2";
    const states: string[] = [];
    for (let i = 0; i < 5; i += 1) states.push((await handleChannelJoin(lineSignal())).state);
    expect(states).toEqual(["created", "created", "rate_limited", "rate_limited", "rate_limited"]);
    expect(ticketOrgs.length).toBe(2);
    const summaries = sent.filter((text) => text.includes("上限"));
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("2");
    // body-free: ids / counts only
    expect(summaries[0]).not.toMatch(/xox[bp]-/);
    expect(audits.some((a) => a.action === "channel_stuck.notice" && a.metadata?.event === "channel_stuck.proposal_rate_limited")).toBe(true);
  });

  test("the cap is per org: org A over the cap does not stop org B", async () => {
    process.env.CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR = "1";
    expect((await handleChannelJoin(lineSignal(ORG))).state).toBe("created");
    expect((await handleChannelJoin(lineSignal(ORG))).state).toBe("rate_limited");
    expect((await handleChannelJoin(lineSignal(OTHER_ORG))).state).toBe("created");
    expect(ticketOrgs).toEqual([ORG, OTHER_ORG]);
  });

  test("a rate-limited channel can be proposed again once budget returns (claim was released)", async () => {
    process.env.CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR = "1";
    await handleChannelJoin(lineSignal());
    const limited = lineSignal();
    expect((await handleChannelJoin(limited)).state).toBe("rate_limited");
    resetChannelClassifyBudgetFallbackForTests();
    resetDemoChannelClassifyStore(); // new window (demo store) — the claim must not linger as in_flight
    expect((await handleChannelJoin(limited)).state).toBe("created");
  });

  test("env is bounded: garbage / huge values fall back to safe limits", async () => {
    const { maxProposalsPerHour, maxNoticesPerHour } = await import("@/lib/channel-classify/budget");
    process.env.CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR = "abc";
    expect(maxProposalsPerHour()).toBe(20);
    process.env.CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR = "100000";
    expect(maxProposalsPerHour()).toBeLessThanOrEqual(200);
    process.env.CHANNEL_STUCK_MAX_NOTICES_PER_HOUR = "-5";
    expect(maxNoticesPerHour()).toBe(30);
  });
});

describe("H1 notices: per-org hourly cap", () => {
  test("distinct notices over the cap → one summary, then rate_limited (nothing sent)", async () => {
    process.env.CHANNEL_STUCK_MAX_NOTICES_PER_HOUR = "2";
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(
        await notifyChannelStuck({ orgId: ORG, kind: "unregistered_channel_denied", ref: { surface: "slack", externalId: `C0CAPN${i}000` }, reason: "external_confidential_denied" })
      );
    }
    expect(results.slice(0, 2).every((r) => r.status === "sent_default")).toBe(true);
    expect(results[2].status).toBe("sent_default");
    expect(results[2].summary).toBe(true);
    expect(results[3].status).toBe("rate_limited");
    expect(results[4].status).toBe("rate_limited");
    expect(sent.length).toBe(3);
    expect(sent[2]).toContain("上限");
    expect(sent[2]).not.toContain("C0CAPN2000"); // the summary does not list the suppressed channels' content
  });

  test("per org: another org still gets its notices", async () => {
    process.env.CHANNEL_STUCK_MAX_NOTICES_PER_HOUR = "1";
    await notifyChannelStuck({ orgId: ORG, kind: "proposal_failed", ref: { surface: "slack", externalId: "C0CAPO0001" }, reason: "x" });
    await notifyChannelStuck({ orgId: ORG, kind: "proposal_failed", ref: { surface: "slack", externalId: "C0CAPO0002" }, reason: "x" });
    const other = await notifyChannelStuck({ orgId: OTHER_ORG, kind: "proposal_failed", ref: { surface: "slack", externalId: "C0CAPO0003" }, reason: "x" });
    expect(other.status).toBe("sent_default");
  });
});

describe("H1 Telegram: my_chat_member.from must be a known member", () => {
  const channel = {
    id: "nc_tg_inbox",
    orgId: ORG,
    provider: "telegram",
    enabled: true,
    config: { chatId: "-1000000000001", allowedUserIds: ["111"] },
    secrets: {},
  } as unknown as NotificationChannelRuntime;
  const update = (fromId: number | undefined, chatId = -1001112223334) => ({
    my_chat_member: {
      chat: { id: chatId, type: "supergroup" },
      ...(fromId === undefined ? {} : { from: { id: fromId, is_bot: false } }),
      old_chat_member: { status: "left", user: { id: 42, is_bot: true } },
      new_chat_member: { status: "member", user: { id: 42, is_bot: true } },
    },
  });

  test("adder in the inbox's allowedUserIds → proposal", async () => {
    const outcome = await handleTelegramMyChatMember(channel, update(111, -1001110000001));
    expect(outcome.state).toBe("created");
  });

  test("adder with a verified voter binding on this inbox → proposal", async () => {
    setJoinDepsForTests({
      telegramVoterMember: async (orgId, channelKey, userId) => (orgId === ORG && channelKey === "nc_tg_inbox" && userId === "222" ? "member_222" : null),
      // #280 pre-flag: the bound member must be active in this org (fixture member)
      memberActiveInOrg: async (orgId, memberId) => orgId === ORG && memberId === "member_222",
    });
    const outcome = await handleTelegramMyChatMember(channel, update(222, -1001110000002));
    expect(outcome.state).toBe("created");
  });

  test("unknown adder → skipped (no ticket, no notice), audited with ids only", async () => {
    setJoinDepsForTests({ telegramVoterMember: async () => null });
    const outcome = await handleTelegramMyChatMember(channel, update(999, -1001110000003));
    expect(outcome).toMatchObject({ state: "skipped", reason: "unknown_adder" });
    expect(ticketOrgs.length).toBe(0);
    expect(sent.length).toBe(0);
  });

  test("missing from → skipped (fail-closed)", async () => {
    const outcome = await handleTelegramMyChatMember(channel, update(undefined, -1001110000004));
    expect(outcome).toMatchObject({ state: "skipped" });
    expect(ticketOrgs.length).toBe(0);
  });

  test("a voter binding from ANOTHER org / another inbox does not count", async () => {
    setJoinDepsForTests({
      telegramVoterMember: async (orgId, channelKey) => (orgId === OTHER_ORG || channelKey !== "nc_tg_inbox" ? "member_x" : null),
    });
    const outcome = await handleTelegramMyChatMember(channel, update(333, -1001110000005));
    expect(outcome.state).toBe("skipped");
  });

  test("an empty allowedUserIds list does not make everyone known (approval-path default is not reused)", async () => {
    setJoinDepsForTests({ telegramVoterMember: async () => null });
    const open = { ...channel, config: { chatId: "-1000000000001" } } as unknown as NotificationChannelRuntime;
    expect((await handleTelegramMyChatMember(open, update(444, -1001110000006))).state).toBe("skipped");
  });

  test("a Telegram signal that did not pass the adder check is refused by handleChannelJoin", async () => {
    const outcome = await handleChannelJoin({ orgId: ORG, surface: "telegram", externalId: "-1001110000007", trigger: "telegram_my_chat_member" });
    expect(outcome).toMatchObject({ state: "skipped", reason: "actor_unverified" });
  });
});
