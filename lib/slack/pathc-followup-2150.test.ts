/**
 * #292 21:50 follow-up (木村):
 * (1) a channel whose classification card was REJECTED: no wake-skip notice and
 *     no new card for that channel for 30 days; the audit records counts only
 *     (one row per org × channel per 24h); lifted when an admin newly files a
 *     channels.classify request for that channel.
 * (2) the one-time re-wake tells the employee 「このチャンネルで取りこぼした
 *     メンションがあるので、スレッドを読んで対応して」 with channel id + ts, never the body.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { updateWakeWebhook } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import { createApproval, resolveApprovalWithoutWorkflow } from "@/lib/data/approvals";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { processSlackMentionEnvelope } from "@/lib/slack/mention-ingress";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import { decideWakeSkipSuppression, setWakeSkipSuppressionClockForTests, WAKE_SKIP_REJECT_SUPPRESS_DAYS } from "@/lib/channel-classify/reject-suppression";
import { buildPathCRewakeInstructionJa } from "@/lib/slack/pathc-rewake";

const ORG = DEMO_ORG.id;
const EMP = "emp_comm";
const SUB = "U0PCSUB001";
const TEAM = "T0PCTEAM01";
const SPEAKER = "U0PCSPEAK1";
const WAKE_URL = "https://example.test/wake/pathc";
const SECRET_TEXT = "PATHC-BODY-請求書の締め日は25日-XYZZY";
const FLAGS = [
  "P0_USER_CHANNEL_MENTION_INGRESS",
  "CHANNEL_STUCK_NOTIFY_ENABLED",
  "CHANNEL_CLASSIFY_PROPOSALS_ENABLED",
  "CHANNEL_STUCK_MAX_NOTICES_PER_HOUR",
  "CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR",
  "PATHC_REWAKE_ON_CLASSIFY_ENABLED",
];
const saved = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

let sent: string[] = [];
let audits: Array<{ orgId: string; action: string; summary?: string; metadata?: Record<string, unknown> }> = [];
let tickets: Array<{ orgId: string; summary: string; metadata: unknown }> = [];
let wakes: Array<Record<string, unknown>> = [];
let seq = 0;
let ticketIds: string[] = [];
let restoreEmp: (() => void) | null = null;

function inbox(orgId: string): NotificationChannelRuntime {
  return { id: `nc_${orgId}`, orgId, provider: "slack", label: "x", enabled: true, isDefault: true, config: {}, secrets: {} } as unknown as NotificationChannelRuntime;
}

function channelId(): string {
  seq += 1;
  return `C0PC${Date.now().toString(36).toUpperCase().slice(-5)}${seq}`.slice(0, 14);
}

function envelope(channel: string, opts: { team?: string; subscriberTeam?: string; text?: string } = {}) {
  seq += 1;
  return {
    type: "event_callback",
    team_id: opts.team ?? TEAM,
    event_id: `Ev0PC${Date.now().toString(36)}${seq}`,
    event: {
      type: "message",
      channel_type: "channel",
      user: SPEAKER,
      text: opts.text ?? `<@${SUB}> ${SECRET_TEXT}`,
      ts: `1788100${String(seq).padStart(3, "0")}.000${String(seq).padStart(3, "0")}`,
      channel,
    },
    authorizations: [{ is_bot: false, user_id: SUB, team_id: opts.subscriberTeam ?? TEAM }],
  };
}

const skip = (channel: string, opts?: Parameters<typeof envelope>[1]) =>
  processSlackMentionEnvelope(envelope(channel, opts) as Parameters<typeof processSlackMentionEnvelope>[0]);
const notices = () => audits.filter((a) => a.action === "channel_stuck.notice");
const wakeSkipNotices = () => notices().filter((a) => a.metadata?.event === "channel_stuck.unclassified_channel_wake_skipped");

beforeEach(async () => {
  for (const key of FLAGS) saved.set(key, process.env[key]);
  for (const key of FLAGS) delete process.env[key];
  process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
  sent = [];
  audits = [];
  tickets = [];
  wakes = [];
  ticketIds = [];
  setWakeSkipSuppressionClockForTests(null);
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  setProposalDepsForTests({
    notifyApproval: async () => true,
    hasApprover: async () => true,
    createApproval: async (input) => {
      tickets.push({ orgId: input.orgId, summary: String(input.summary ?? ""), metadata: input.metadata });
      const created = await createApproval(input);
      ticketIds.push(created.approval.id);
      return created;
    },
  });
  setStuckNotifyDepsForTests({
    listChannels: async (orgId) => [inbox(orgId)],
    send: async (_channel, text) => {
      sent.push(text);
      return { ok: true };
    },
    audit: async (event) => {
      audits.push(event as (typeof audits)[number]);
    },
    mail: async () => ({ ok: true }),
  });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(WAKE_URL)) {
      wakes.push(JSON.parse(String(init?.body || "{}")));
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: "not_authed" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const emp = getRuntimeEmployees().find((item) => item.id === EMP)!;
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: SUB }] as typeof emp.allowedAccounts;
  restoreEmp = () => {
    emp.allowedAccounts = previous;
  };
  await revokeEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG }).catch(() => undefined);
  await bindEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG, slackUserId: SUB, slackTeamId: TEAM, displayName: "稲盛", userToken: "xoxp-pathc-test" });
  await updateWakeWebhook(EMP, { orgId: ORG, url: WAKE_URL, secret: "pathc-wake-secret" });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setProposalDepsForTests(null);
  setStuckNotifyDepsForTests(null);
  await revokeEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG }).catch(() => undefined);
  await updateWakeWebhook(EMP, { orgId: ORG, url: null, secret: "" }).catch(() => undefined);
  restoreEmp?.();
  for (const key of FLAGS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});


const DAY = 24 * 60 * 60 * 1000;
const suppressedRows = (channel: string) =>
  getRuntimeAudit().filter((a) => a.action === "channel_classify.wake_skip_suppressed" && JSON.stringify(a.metadata ?? {}).includes(channel));

function bothOn() {
  process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
}

/** Skip once (card + notice), reject the card, then clear the 6h notice window / card dedupe so only the new rule can hold. */
async function rejectedChannel(orgId = ORG): Promise<{ channel: string; rejectedId: string }> {
  const channel = channelId();
  await skip(channel);
  expect(tickets.length).toBe(1);
  const rejectedId = ticketIds.at(-1)!;
  await resolveApprovalWithoutWorkflow(rejectedId, "rejected", "fixture-human", orgId);
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  sent = [];
  audits = [];
  tickets = [];
  return { channel, rejectedId };
}

async function adminRequest(orgId: string, channel: string, requester: Record<string, unknown> = { kind: "admin_agent", actorId: "adm_fixture" }) {
  return createApproval({
    orgId,
    employeeId: "",
    credentialId: "",
    title: "fixture admin request",
    purpose: "admin.channel",
    summary: "fixture",
    risk: "high",
    tool: "channels.classify",
    metadata: {
      approvalClass: "admin",
      adminTool: "channels.classify",
      isAdminMcpTool: true,
      adminMutation: { surface: "slack", externalId: channel, classification: "internal", mixed: false },
      ...(requester.kind === "system" ? { proposalRequester: requester } : { adminRequester: requester }),
    },
  });
}

describe("(1) rejected card → 30-day suppression of the wake-skip notice and card", () => {
  test("after a rejection: further skips send no notice and open no card", async () => {
    bothOn();
    const { channel } = await rejectedChannel();
    await skip(channel);
    await skip(channel);
    expect(sent).toEqual([]);
    expect(tickets).toEqual([]);
    expect(wakeSkipNotices()).toEqual([]);
  });

  test("audit: one counts-only row per org × channel per 24h; no message text", async () => {
    bothOn();
    const { channel, rejectedId } = await rejectedChannel();
    await skip(channel);
    await skip(channel);
    await skip(channel);
    const rows = suppressedRows(channel);
    expect(rows.length).toBe(1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(meta.reason).toBe("classify_card_rejected");
    expect(meta.rejectedApprovalId).toBe(rejectedId);
    expect(typeof meta.suppressedCount).toBe("number");
    expect(meta.suppressedCount as number).toBeGreaterThanOrEqual(1);
    expect(rows[0].orgId).toBe(ORG);
    expect(JSON.stringify(rows)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(rows)).not.toContain(SPEAKER);
  });

  test("after 30 days the suppression ends (notice + card again)", async () => {
    bothOn();
    const { channel } = await rejectedChannel();
    expect(WAKE_SKIP_REJECT_SUPPRESS_DAYS).toBe(30);
    setWakeSkipSuppressionClockForTests(() => Date.now() + 31 * DAY);
    await skip(channel);
    expect(tickets.length).toBe(1);
    expect(sent.length).toBe(1);
  });

  test("still suppressed on day 29", async () => {
    bothOn();
    const { channel } = await rejectedChannel();
    setWakeSkipSuppressionClockForTests(() => Date.now() + 29 * DAY);
    await skip(channel);
    expect(tickets).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("lifted when an admin files a new channels.classify request for that channel", async () => {
    bothOn();
    const { channel } = await rejectedChannel();
    await adminRequest(ORG, channel);
    await skip(channel);
    expect(sent.length).toBe(1);
    expect(wakeSkipNotices().length).toBe(1);
  });

  test("NOT lifted by an admin request for another channel or by a system card", async () => {
    bothOn();
    const { channel } = await rejectedChannel();
    await adminRequest(ORG, channelId());
    await adminRequest(ORG, channel, { kind: "system", source: "backfill" });
    await skip(channel);
    expect(sent).toEqual([]);
    expect(tickets).toEqual([]);
  });

  test("an APPROVED (not rejected) card does not suppress anything", async () => {
    bothOn();
    const channel = channelId();
    await skip(channel);
    await resolveApprovalWithoutWorkflow(ticketIds.at(-1)!, "approved", "fixture-human", ORG);
    resetDemoChannelClassifyStore();
    sent = [];
    await skip(channel);
    expect(sent.length).toBe(1);
    expect(suppressedRows(channel)).toEqual([]);
  });

  test("BOLA: another org's rejected card never suppresses this org; another org's admin request never lifts it", () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const ch = "C0BOLATEST1";
    const card = (orgId: string, status: string, resolvedMs: number | null) => ({
      id: `apr_${orgId}_${status}`,
      orgId,
      tool: "channels.classify",
      status,
      createdAt: iso(now - 2 * DAY),
      resolvedAt: resolvedMs == null ? null : iso(resolvedMs),
      metadata: { adminMutation: { surface: "slack", externalId: ch }, proposalRequester: { kind: "system", source: "wake_skipped" } },
    });
    const adminReq = (orgId: string, createdMs: number, externalId = ch) => ({
      id: `apr_admin_${orgId}_${externalId}`,
      orgId,
      tool: "channels.classify",
      status: "pending",
      createdAt: iso(createdMs),
      resolvedAt: null,
      metadata: { adminMutation: { surface: "slack", externalId }, adminRequester: { kind: "admin_agent", actorId: "a" } },
    });
    type Rows = Parameters<typeof decideWakeSkipSuppression>[0]["rows"];
    const decide = (rows: unknown[]) => decideWakeSkipSuppression({ rows: rows as Rows, orgId: ORG, channelId: ch, nowMs: now }).suppressed;
    const own = card(ORG, "rejected", now - DAY);
    // another org's rejected card → this org is not suppressed
    expect(decide([card("org_b", "rejected", now - DAY)])).toBe(false);
    // own rejected card + another org's admin request → still suppressed
    expect(decide([own, adminReq("org_b", now)])).toBe(true);
    // own admin request for another channel → still suppressed
    expect(decide([own, adminReq(ORG, now, "C0OTHERCH1")])).toBe(true);
    // own admin request for this channel after the rejection → lifted
    expect(decide([own, adminReq(ORG, now)])).toBe(false);
    // own admin request filed BEFORE the rejection is not a new request
    expect(decide([own, adminReq(ORG, now - 2 * DAY)])).toBe(true);
    // a rejected request filed by an admin (not a system card) suppresses nothing
    expect(decide([{ ...adminReq(ORG, now - 2 * DAY), status: "rejected", resolvedAt: iso(now - DAY) }])).toBe(false);
    // rejected 31 days ago → expired
    expect(decide([card(ORG, "rejected", now - 31 * DAY)])).toBe(false);
  });

  test("flags OFF: no suppression row is ever written", async () => {
    const channel = channelId();
    await skip(channel);
    expect(suppressedRows(channel)).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("(2) re-wake instruction text (no body)", () => {
  test("says there is a missed mention in this channel and to read the thread and respond; carries channel + ts only", () => {
    const text = buildPathCRewakeInstructionJa({ channelId: "C0ABCDEF12", ts: "1788100001.000001", threadTs: "1788100000.000100" });
    expect(text).toContain("取りこぼしたメンション");
    expect(text).toContain("スレッドを読んで対応");
    expect(text).toContain("C0ABCDEF12");
    expect(text).toContain("1788100001.000001");
    expect(text).toContain("1788100000.000100");
  });

  test("never interpolates anything that is not a channel id / ts", () => {
    const text = buildPathCRewakeInstructionJa({ channelId: `C0X ${SECRET_TEXT}`, ts: `1.2 ${SECRET_TEXT}`, threadTs: SECRET_TEXT });
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).toContain("取りこぼしたメンション");
  });
});

describe("21:53 review (1): notice wording — classify as external instead of rejecting", () => {
  test("the wake-skip notice tells the approver to classify an external channel as external; reject only to keep the AI employee out", async () => {
    bothOn();
    const channel = channelId();
    await skip(channel);
    expect(sent.length).toBe(1);
    // 22:13: wording aligned with the shared_external card (reject-guidance.ts)
    expect(sent[0]).toContain("却下するのは、この AI 社員に対応させたくないときだけ。分類が違うときは、正しい区分で分類し直してください");
    expect(sent[0]).toContain("classification=shared_external");
    expect(sent[0]).not.toContain("社外と共有されているなら却下");
  });

  test("the #276 egress-deny notice uses the same wording", async () => {
    const { buildStuckNoticeTextJa } = await import("@/lib/channel-classify/stuck-notify");
    const text = buildStuckNoticeTextJa(
      { orgId: ORG, kind: "unclassified_channel_wake_skipped", ref: { surface: "slack", externalId: "C0WORDING1" }, reason: "channel_not_classified", approvalId: "apr_wording_1", proposalState: "created" },
      { surface: "slack", externalId: "C0WORDING1" },
      "channel_not_classified"
    );
    expect(text).not.toContain("社外と共有されているなら却下");
    const { buildUnregisteredDenyNoticeJa } = await import("@/lib/channel-classify/core");
    const deny = buildUnregisteredDenyNoticeJa({ ref: { surface: "slack", externalId: "C0WORDING1" }, reason: "unclassified_channel", approvalId: "apr_wording_2", proposalState: "created" });
    expect(deny).toContain("却下するのは、この AI 社員に対応させたくないときだけ");
    expect(deny).not.toContain("社外と共有されているなら却下");
  });
});

describe("21:53 review (2): the claim only accepts THIS channel's classification ticket", () => {
  async function approved(tool: string, metadata: Record<string, unknown>) {
    const created = await createApproval({ orgId: ORG, employeeId: "", credentialId: "", title: "x", purpose: "admin.channel", summary: "x", risk: "high", tool, metadata });
    return (await resolveApprovalWithoutWorkflow(created.approval.id, "approved", "fixture-human", ORG))!;
  }

  test("an approved ticket for another channel, another tool, or a non-classification config change cannot claim; the channel's own ticket can", async () => {
    process.env.PATHC_REWAKE_ON_CLASSIFY_ENABLED = "true";
    const { claimSkippedChannelWakes } = await import("@/lib/data/slack-skipped-wakes");
    const channel = channelId();
    await skip(channel);
    const claim = (approvalId: string) => claimSkippedChannelWakes({ orgId: ORG, channelId: channel, approvalId, ttlSeconds: 3600 });
    const otherChannel = await approved("channels.classify", { adminMutation: { surface: "slack", externalId: "C0OTHERCH9", classification: "internal" } });
    const otherTool = await approved("parties.upsert", { adminMutation: { surface: "slack", externalId: channel } });
    const noTarget = await approved("channels.classify", { adminMutation: {} });
    const lineSurface = await approved("channels.classify", { adminMutation: { surface: "line", externalId: channel } });
    const instructions = await approved("config.change_request", { configChange: { proposal: { kind: "instructions", mode: "append", text: "x" } } });
    for (const a of [otherChannel, otherTool, noTarget, lineSurface, instructions]) {
      expect((await claim(a.id)).state).toBe("denied");
    }
    const own = await approved("channels.classify", { adminMutation: { surface: "slack", externalId: channel, classification: "internal" } });
    const result = await claim(own.id);
    expect(result.state).toBe("ok");
    expect(result.state === "ok" ? result.rows.length : -1).toBe(1);
  });

  test("a config-change channel_classification for this channel is accepted", async () => {
    process.env.PATHC_REWAKE_ON_CLASSIFY_ENABLED = "true";
    const { claimSkippedChannelWakes } = await import("@/lib/data/slack-skipped-wakes");
    const channel = channelId();
    await skip(channel);
    const cc = await approved("config.change_request", { configChange: { proposal: { kind: "channel_classification", surface: "slack", externalId: channel, classification: "internal" } } });
    const result = await claimSkippedChannelWakes({ orgId: ORG, channelId: channel, approvalId: cc.id, ttlSeconds: 3600 });
    expect(result.state === "ok" ? result.rows.length : -1).toBe(1);
  });
});
