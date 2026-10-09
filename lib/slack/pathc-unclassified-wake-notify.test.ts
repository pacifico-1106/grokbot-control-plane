/**
 * Path C (木村 2026-10-09): a user-token channel mention skipped because the
 * channel is unclassified (稲盛 10/6, C0B7DRAJDQR) must no longer be silent.
 * The skip reuses #276/#280's stuck notice (CHANNEL_STUCK_NOTIFY_ENABLED) and
 * classification-proposal card (CHANNEL_CLASSIFY_PROPOSALS_ENABLED): ids only,
 * existing per-org × channel dedupe window and per-org hourly caps. Both flags
 * OFF → exactly today's behaviour.
 *
 * Demo mode, dummy ids, no network (fetch mocked).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { updateWakeWebhook } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import { createApproval } from "@/lib/data/approvals";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { processSlackMentionEnvelope } from "@/lib/slack/mention-ingress";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

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
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  setProposalDepsForTests({
    notifyApproval: async () => true,
    hasApprover: async () => true,
    createApproval: async (input) => {
      tickets.push({ orgId: input.orgId, summary: String(input.summary ?? ""), metadata: input.metadata });
      return createApproval(input);
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

describe("flags OFF: unchanged", () => {
  test("both flags OFF → same skip outcome, no notice, no ticket, no wake, no new audit kinds", async () => {
    const channel = channelId();
    const outcome = await skip(channel);
    expect(outcome).toEqual({ handled: true, woke: 0, skipReason: "user_channel_not_classified", userToken: true, isUserTokenChannel: true });
    expect(sent).toEqual([]);
    expect(tickets).toEqual([]);
    expect(notices()).toEqual([]);
    expect(wakes).toEqual([]);
    const actions = new Set(getRuntimeAudit().filter((a) => JSON.stringify(a).includes(channel)).map((a) => a.action));
    expect([...actions]).toEqual(["slack.user_token_channel_wake_skipped"]);
  });

  test("a classified channel still wakes as before (hook never runs on the wake path)", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
    const channel = channelId();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    const outcome = await skip(channel);
    expect(outcome.woke).toBe(1);
    expect(wakes.length).toBe(1);
    expect(sent).toEqual([]);
    expect(tickets).toEqual([]);
  });
});

describe("CHANNEL_STUCK_NOTIFY_ENABLED: unclassified skip → one stuck notice (ids only)", () => {
  test("notice once per org × channel window; skip outcome unchanged; second mention suppressed", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    const channel = channelId();
    const first = await skip(channel);
    expect(first.skipReason).toBe("user_channel_not_classified");
    expect(first.woke).toBe(0);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain(channel);
    expect(sent[0]).toContain("channels.classify");
    expect(wakeSkipNotices().length).toBe(1);
    expect(wakeSkipNotices()[0].orgId).toBe(ORG);
    expect(wakeSkipNotices()[0].metadata?.externalId).toBe(channel);
    expect(wakeSkipNotices()[0].metadata?.reason).toBe("channel_not_classified");
    await skip(channel);
    await skip(channel);
    expect(sent.length).toBe(1);
    expect(tickets).toEqual([]); // proposals flag OFF
  });

  test("per-org hourly notice cap holds: over the cap → one summary, then nothing", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    process.env.CHANNEL_STUCK_MAX_NOTICES_PER_HOUR = "2";
    for (let i = 0; i < 5; i += 1) await skip(channelId());
    expect(sent.length).toBe(3);
    expect(sent.filter((t) => t.includes("上限")).length).toBe(1);
  });

  test("team mismatch / unbound subscriber → no notice (nothing to wake anyway)", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    const outcome = await skip(channelId(), { subscriberTeam: "T0PCOTHER1" });
    expect(outcome.woke).toBe(0);
    expect(sent).toEqual([]);
  });

  test("no message text in the notice, the stuck audit, or the skip audit", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
    const channel = channelId();
    await skip(channel);
    expect(sent.length).toBe(1);
    for (const text of sent) expect(text).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(audits)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(tickets)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(getRuntimeAudit().filter((a) => JSON.stringify(a).includes(channel)))).not.toContain(SECRET_TEXT);
  });
});

describe("CHANNEL_CLASSIFY_PROPOSALS_ENABLED: unclassified skip → one proposal card", () => {
  test("first skip opens one channels.classify ticket (trigger wake_skipped); repeats reuse it", async () => {
    process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
    const channel = channelId();
    await skip(channel);
    await skip(channel);
    await skip(channel);
    expect(tickets.length).toBe(1);
    expect(tickets[0].orgId).toBe(ORG);
    expect(JSON.stringify(tickets[0].metadata)).toContain("wake_skipped");
    expect(sent).toEqual([]); // stuck flag OFF
  });

  test("both flags ON: the notice carries the approval id of the card", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
    const channel = channelId();
    await skip(channel);
    expect(tickets.length).toBe(1);
    const approvalId = String(wakeSkipNotices()[0].metadata?.approvalId);
    expect(approvalId.length).toBeGreaterThan(4);
    expect(sent[0]).toContain(approvalId);
  });

  test("per-org hourly proposal cap holds", async () => {
    process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
    process.env.CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR = "2";
    for (let i = 0; i < 4; i += 1) await skip(channelId());
    expect(tickets.length).toBe(2);
  });

  test("a channel registered as unknown gets the notice but no new card (registered)", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
    const channel = channelId();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "unknown", skipInspect: true });
    const outcome = await skip(channel);
    expect(outcome.skipReason).toBe("user_channel_not_classified");
    expect(tickets).toEqual([]);
    expect(sent.length).toBe(1);
  });
});
