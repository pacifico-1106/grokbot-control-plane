/**
 * #254 follow-up 2: W1 (unanswered mention) covers the user-token channel wake
 * (Path C, `slack.user_token_channel_wake`) exactly like the other Slack triggers.
 * All outbound HTTP is mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees, pushRuntimeAuditEvent } from "@/lib/demo-data";
import { isMentionWakeAudit } from "@/lib/data/audit";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import { evaluateW1Eligibility } from "@/lib/stuck-watch/w1-mention-unanswered";
import type { AuditEvent } from "@/lib/types";

const { processW1MentionWatchForOrg } = await import("@/lib/stuck-watch/w1-mention-unanswered");
const { setOrgStuckWatchPolicy, resetDemoStuckWatchPolicy } = await import("@/lib/data/stuck-watch-policy");
const { upsertNotificationChannel } = await import("@/lib/data/notification-channels");
const { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { updateWakeWebhook } = await import("@/lib/data");
const { upsertOrgChannel } = await import("@/lib/data/directory");
const { processSlackMentionEnvelope } = await import("@/lib/slack/mention-ingress");

const WAKE_ACTIONS = [
  "slack.mention_wake",
  "slack.internal_im_wake",
  "slack.user_token_im_wake",
  "slack.user_token_channel_wake",
] as const;

let savedFetch: typeof fetch;
let calls: Array<{ url: string; body: string }> = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["P0_USER_CHANNEL_MENTION_INGRESS", "SLACK_SIGNING_SECRET"];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  savedFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body || "") });
    return Response.json({ ok: true, channel: "C_W1_MOUTH", ts: "999.1" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetDemoStuckWatchPolicy();
});

function wake(action: string, overrides: Partial<AuditEvent> = {}, meta: Record<string, unknown> = {}): AuditEvent {
  return {
    id: `aud_${action}_${Math.random().toString(36).slice(2, 8)}`,
    orgId: DEMO_ORG.id,
    employeeId: "emp_comm",
    credentialId: null,
    action,
    purpose: "slack.user_token_channel",
    summary: "wake",
    metadata: { reason: "woke", channel: "C_W1_UTC", ts: "1787911900.000100", thread_ts: null, ...meta },
    createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...overrides,
  } as AuditEvent;
}

describe("W1 wake set", () => {
  for (const action of WAKE_ACTIONS) {
    test(`${action} (reason=woke) is a W1 wake`, () => {
      expect(isMentionWakeAudit(wake(action))).toBe(true);
    });
  }

  test("user-token channel: not delivered / skipped / DL-3 detail row are not W1 wakes", () => {
    expect(isMentionWakeAudit(wake("slack.user_token_channel_wake", {}, { reason: "wake_failed" }))).toBe(false);
    expect(isMentionWakeAudit(wake("slack.user_token_channel_wake_skipped"))).toBe(false);
    // The DL-3 detail audit has no `reason` (its `channel` is an object) → not a second wake.
    const dl3 = wake("slack.user_token_channel_wake");
    dl3.metadata = { channel: { channelId: "C_W1_UTC" }, outcome: { woke: true } };
    expect(isMentionWakeAudit(dl3)).toBe(false);
  });

  test("same eligibility rules as the other triggers (too soon / replied / eligible)", () => {
    const policy = defaultStuckWatchPolicy();
    const base = { policy, approvals: [], now: new Date(), resolvedItemIds: new Set<string>(), notifiedItemIds: new Set<string>() };
    for (const action of WAKE_ACTIONS) {
      const w = wake(action);
      expect(evaluateW1Eligibility({ ...base, wake: w, audits: [w] }).eligible).toBe(true);
      const soon = wake(action, { createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
      expect(evaluateW1Eligibility({ ...base, wake: soon, audits: [soon] }).reason).toBe("too_soon");
      const reply = {
        ...w, id: `${w.id}_reply`, action: "tool.invoke", credentialId: "cred_comm",
        summary: "comm.reply を自動実行", metadata: { tool: "comm.reply", destination: "C_W1_UTC" },
        createdAt: new Date(new Date(w.createdAt).getTime() + 60_000).toISOString(),
      } as AuditEvent;
      expect(evaluateW1Eligibility({ ...base, wake: w, audits: [reply, w] }).reason).toBe("already_replied");
    }
  });
});

async function mouth() {
  const ch = await upsertNotificationChannel({
    orgId: DEMO_ORG.id, provider: "slack", label: "W1 mouth", enabled: true,
    config: { channelId: "C_W1_MOUTH" }, secrets: { botToken: "xoxb-w1-mouth", signingSecret: "s" },
  });
  await setOrgStuckWatchPolicy(DEMO_ORG.id, { enabled: true, notifyMouth: ch.id, mentionUnansweredMinutes: 15 });
  return ch;
}

describe("W1 cron notifies an unanswered user-token channel mention", () => {
  test("pushed user-token channel wake → one W1 notice; second run deduped", async () => {
    await mouth();
    const w = pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: null,
      action: "slack.user_token_channel_wake", purpose: "slack.user_token_channel", summary: "wake",
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      metadata: { reason: "woke", channel: "C_W1_PUSH", ts: "1787911900.000200", thread_ts: null },
    });
    const first = await processW1MentionWatchForOrg(DEMO_ORG.id);
    const mine = first.filter((r) => r.itemId === "w1:C_W1_PUSH:1787911900.000200");
    expect(mine.length).toBe(1);
    expect(mine[0].ok).toBe(true);
    const notice = getRuntimeAudit().find((e) => e.action === "stuck_watch.w1_notify" && e.metadata?.itemId === "w1:C_W1_PUSH:1787911900.000200");
    expect(notice?.employeeId).toBe(w.employeeId);
    const second = await processW1MentionWatchForOrg(DEMO_ORG.id);
    expect(second.filter((r) => r.itemId === "w1:C_W1_PUSH:1787911900.000200").length).toBe(0);
  });

  test("real Path C ingress wake (postWake audit) is detected; the DL-3 row does not double-notify", async () => {
    process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
    process.env.SLACK_SIGNING_SECRET = "w1-utc-signing";
    await mouth();
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: "U_W1_BOUND" }];
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    await bindEmployeeSlackIdentity({
      employeeId: emp.id, orgId: DEMO_ORG.id, slackUserId: "U_W1_BOUND", slackTeamId: "T_DEMO",
      displayName: "W1", userToken: "xoxp-w1-test",
    });
    await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: "https://example.test/wake/w1", secret: "w1-wake-secret" });
    try {
      await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: "C_W1_REAL", classification: "internal", skipInspect: true });
      await processSlackMentionEnvelope({
        type: "event_callback", team_id: "T_DEMO", event_id: `Ev_w1_utc_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: "U_W1_BOUND", team_id: "T_DEMO" }],
        event: { type: "message", channel_type: "channel", user: "U_W1_HUMAN", text: "<@U_W1_BOUND> 見て", ts: "1787911900.000300", channel: "C_W1_REAL" },
      });
      const rows = getRuntimeAudit().filter((e) => e.action === "slack.user_token_channel_wake" && e.employeeId === emp.id);
      expect(rows.length).toBeGreaterThanOrEqual(2); // postWake row + DL-3 detail row
      const woke = rows.filter((e) => e.metadata?.reason === "woke");
      expect(woke.length).toBe(1);
      for (const r of rows) r.createdAt = new Date(Date.now() - 30 * 60_000).toISOString();
      const results = await processW1MentionWatchForOrg(DEMO_ORG.id);
      expect(results.filter((r) => r.itemId === "w1:C_W1_REAL:1787911900.000300").length).toBe(1);
      expect(getRuntimeAudit().filter((e) => e.action === "stuck_watch.w1_notify" && e.metadata?.itemId === "w1:C_W1_REAL:1787911900.000300").length).toBe(1);
    } finally {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: null, secret: "" });
      emp.allowedAccounts = previous;
    }
  });

  test("same channel/ts seen twice in one run → one notice (itemId dedupe)", async () => {
    await mouth();
    for (let i = 0; i < 2; i++) {
      pushRuntimeAuditEvent({
        orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: null,
        action: "slack.user_token_channel_wake", purpose: "slack.user_token_channel", summary: "wake",
        createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        metadata: { reason: "woke", channel: "C_W1_DUP", ts: "1787911900.000400" },
      });
    }
    await processW1MentionWatchForOrg(DEMO_ORG.id);
    expect(getRuntimeAudit().filter((e) => e.action === "stuck_watch.w1_notify" && e.metadata?.itemId === "w1:C_W1_DUP:1787911900.000400").length).toBe(1);
  });
});
