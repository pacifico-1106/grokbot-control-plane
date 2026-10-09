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
import { setWakeSkipSuppressionClockForTests, WAKE_SKIP_REJECT_SUPPRESS_DAYS } from "@/lib/channel-classify/reject-suppression";
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

  test("NOT lifted by an admin request for another channel, another org's request, or a system card", async () => {
    bothOn();
    const { channel } = await rejectedChannel();
    await adminRequest(ORG, channelId());
    await adminRequest("org_other_tenant_fixture", channel);
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

  test("another org's rejected card for the same channel id does not suppress this org", async () => {
    bothOn();
    const channel = channelId();
    const other = await createApproval({
      orgId: "org_other_tenant_fixture",
      employeeId: "",
      credentialId: "",
      title: "x",
      purpose: "admin.channel",
      summary: "x",
      risk: "high",
      tool: "channels.classify",
      metadata: { adminTool: "channels.classify", adminMutation: { surface: "slack", externalId: channel }, proposalRequester: { kind: "system", source: "wake_skipped" } },
    });
    await resolveApprovalWithoutWorkflow(other.approval.id, "rejected", "x", "org_other_tenant_fixture");
    await skip(channel);
    expect(sent.length).toBe(1);
    expect(tickets.length).toBe(1);
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
