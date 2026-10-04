/**
 * MCP endpoint handoff — per-channel tests.
 * Every wake path (Slack user-token channel / user-token IM / bot mention / internal IM,
 * approval.resolved via Slack / LINE / Telegram / Web / proxy) must go through the
 * same shared module and carry the same machine-readable block. Not-connected next
 * step notifications must reach Slack, LINE and Telegram mouths alike.
 * All outbound HTTP is mocked (no real Slack / LINE / Telegram API calls).
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApprovalRequest } from "@/lib/types";

mock.module("@/lib/approvals/fulfill", () => ({
  fulfillIfApproved: async () => undefined,
  fulfillApprovedInvoke: async () => ({ ok: true }),
}));
mock.module("@/lib/admin-mcp/fulfill-admin", () => ({ fulfillApprovedAdmin: async () => null }));

const { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees, pushRuntimeAuditEvent } =
  await import("@/lib/demo-data");
const { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { updateWakeWebhook } = await import("@/lib/data");
const { upsertOrgChannel } = await import("@/lib/data/directory");
const { deleteSlackImEmployeeRoute, syncSlackImEmployeeRoute } = await import("@/lib/data/slack-im-routes");
const { handleSlackEventsRequest, processSlackMentionEnvelope } = await import("@/lib/slack/mention-ingress");
const { createApproval } = await import("@/lib/data/approvals");
const { upsertNotificationChannel, recordNotificationDelivery } = await import("@/lib/data/notification-channels");
const { resetDemoWorkflowData } = await import("@/lib/approval-workflow/data");
const { runApprovalResolveSideEffects } = await import("@/lib/approvals/resolve-side-effects");
const { setOrgStuckWatchPolicy, resetDemoStuckWatchPolicy } = await import("@/lib/data/stuck-watch-policy");
const { processMcpNotConnectedWatchForOrg } = await import("@/lib/mcp/endpoint-handoff");
const { POST: slackRef } = await import("@/app/api/webhooks/slack/[ref]/route");
const { POST: lineRef } = await import("@/app/api/webhooks/line/[ref]/route");
const { POST: telegramRef } = await import("@/app/api/webhooks/telegram/[ref]/route");

const FLAG = "MCP_ENDPOINT_HANDOFF_ENABLED";
const ORIGIN = "https://handoff-channels.example.test";
const MCP_URL = `${ORIGIN}/api/mcp`;
const SIGNING_SECRET = "slack-events-signing-secret-for-tests";
const WAKE_URL = "https://example.test/wake/handoff";
const WAKE_SECRET = "sender-key-handoff";
const CALLBACK_URL = "https://example.test/callback/handoff";
const BOUND_USER = "U_HANDOFF";
const SPEAKER = "U_HUMAN_H";
const TEAM = "T_DEMO";
const CHANNEL = "C_HANDOFF";
const INTERNAL_IM = "DHANDOFFINTERNAL";
const HUMAN_DM = "DHANDOFFHUMANDM";

type Call = { url: string; auth: string; body: string };
let calls: Call[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [FLAG, "NEXT_PUBLIC_APP_URL", "SLACK_SIGNING_SECRET", "P0_USER_CHANNEL_MENTION_INGRESS"];
let savedFetch: typeof fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  savedFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const headers = (init?.headers || {}) as Record<string, string>;
    calls.push({ url, auth: String(headers.authorization || ""), body: String(init?.body || "") });
    return Response.json({ ok: true, channel: "C_FIXTURE", ts: "123.45", result: { message_id: 77 } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetDemoWorkflowData();
  resetDemoStuckWatchPolicy();
});

function wakeCalls() {
  return calls.filter((c) => c.url === WAKE_URL).map((c) => JSON.parse(c.body) as Record<string, unknown>);
}
function callbackCalls() {
  return calls.filter((c) => c.url === CALLBACK_URL).map((c) => JSON.parse(c.body) as Record<string, unknown>);
}

function signedSlackEvent(body: unknown) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return { rawBody, timestamp, signature };
}

async function bindEmployee() {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
  if (!emp) throw new Error("missing emp_comm");
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: BOUND_USER }];
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
  await bindEmployeeSlackIdentity({
    employeeId: emp.id,
    orgId: DEMO_ORG.id,
    slackUserId: BOUND_USER,
    slackTeamId: TEAM,
    displayName: "ハンドオフ",
    userToken: "xoxp-test",
  });
  await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: WAKE_URL, secret: WAKE_SECRET });
  return {
    emp,
    restore: async () => {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: null, secret: "" });
      emp.allowedAccounts = previous;
    },
  };
}

async function routeIm(employeeId: string, channel: string) {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
  await syncSlackImEmployeeRoute({
    orgId: DEMO_ORG.id, surface: "slack", slackChannelId: channel, slackTeamId: TEAM,
    classification: "internal", mixed: false, employeeId,
  });
}

function assertHandoff(payload: Record<string, unknown>, surface: string, kind: string, trigger: string) {
  const h = payload.mcpHandoff as Record<string, any>;
  expect(h).toBeTruthy();
  expect(h.schema).toBe("staffpass.mcp_handoff.v1");
  expect(h.mcp.url).toBe(MCP_URL);
  expect(h.connectivityCheck.tool).toBe("staffpass_whoami");
  expect(h.wake).toEqual({ surface, kind, trigger });
  const json = JSON.stringify(h);
  expect(json).not.toContain(WAKE_SECRET);
  expect(json).not.toContain("xoxp-test");
}

type SlackTrigger = "mention" | "internal_im" | "user_token_im" | "user_token_channel";

async function fireSlack(trigger: SlackTrigger, empId: string) {
  const id = `Ev_handoff_${trigger}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  if (trigger === "mention") {
    await handleSlackEventsRequest(signedSlackEvent({
      type: "event_callback", team_id: TEAM, event_id: id,
      event: { type: "message", user: SPEAKER, text: `<@${BOUND_USER}> お願い`, ts: "1787911800.100001", channel: CHANNEL },
    }));
    return;
  }
  if (trigger === "internal_im") {
    await routeIm(empId, INTERNAL_IM);
    await handleSlackEventsRequest(signedSlackEvent({
      type: "event_callback", team_id: TEAM, event_id: id,
      event: { type: "message", channel_type: "im", user: SPEAKER, text: "社内IM", ts: "1787911800.100002", channel: INTERNAL_IM },
    }));
    return;
  }
  if (trigger === "user_token_im") {
    await routeIm(empId, HUMAN_DM);
    await processSlackMentionEnvelope({
      type: "event_callback", team_id: TEAM, event_id: id,
      authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
      event: { type: "message", channel_type: "im", user: SPEAKER, text: "user token IM", ts: "1787911800.100003", channel: HUMAN_DM },
    });
    return;
  }
  process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: CHANNEL, classification: "internal", skipInspect: true });
  await processSlackMentionEnvelope({
    type: "event_callback", team_id: TEAM, event_id: id,
    authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
    event: { type: "message", channel_type: "channel", user: SPEAKER, text: `<@${BOUND_USER}> チャネル`, ts: "1787911800.100004", channel: CHANNEL },
  });
}

const SLACK_CASES: Array<{ name: string; trigger: SlackTrigger; action: string }> = [
  { name: "Slack bot mention", trigger: "mention", action: "slack.mention_wake" },
  { name: "Slack internal IM (bot)", trigger: "internal_im", action: "slack.internal_im_wake" },
  { name: "Slack user-token IM", trigger: "user_token_im", action: "slack.user_token_im_wake" },
  { name: "Slack user-token channel", trigger: "user_token_channel", action: "slack.user_token_channel_wake" },
];

describe("Slack wakes go through the shared handoff", () => {
  for (const c of SLACK_CASES) {
    test(`${c.name}: flag ON → wake payload carries mcpHandoff; audit marks mcpHandoff`, async () => {
      process.env[FLAG] = "true";
      const { emp, restore } = await bindEmployee();
      try {
        await fireSlack(c.trigger, emp.id);
        const wakes = wakeCalls();
        expect(wakes.length).toBe(1);
        assertHandoff(wakes[0], "slack", "conversation", c.trigger);
        expect(wakes[0].employeeId).toBe(emp.id);
        const wakeAudit = getRuntimeAudit().find(
          (e) => e.action === c.action && e.employeeId === emp.id && e.metadata?.reason === "woke"
        );
        expect(wakeAudit?.metadata?.mcpHandoff).toBe(true);
        expect(wakeAudit?.metadata?.surface).toBe("slack");
      } finally {
        await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: INTERNAL_IM });
        await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
        await restore();
      }
    });

    test(`${c.name}: flag OFF → payload unchanged (no mcpHandoff key)`, async () => {
      delete process.env[FLAG];
      const { emp, restore } = await bindEmployee();
      try {
        await fireSlack(c.trigger, emp.id);
        const wakes = wakeCalls();
        expect(wakes.length).toBe(1);
        expect("mcpHandoff" in wakes[0]).toBe(false);
        const last = getRuntimeAudit().find((e) => e.action === c.action && e.employeeId === emp.id);
        expect(last?.metadata?.mcpHandoff).toBeUndefined();
      } finally {
        await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: INTERNAL_IM });
        await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
        await restore();
      }
    });
  }
});

async function pendingApproval(): Promise<ApprovalRequest> {
  return (await createApproval({
    orgId: DEMO_ORG.id, employeeId: "emp_sales", credentialId: "cred_sales", title: "handoff fixture",
    purpose: "fixture", summary: "Fixture", risk: "low", tool: "comm.reply", jobId: crypto.randomUUID(),
  })).approval;
}

function withCallbackUrl<T>(fn: () => Promise<T>): Promise<T> {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_sales");
  if (!emp) throw new Error("missing emp_sales");
  const prev = emp.callbackUrl;
  emp.callbackUrl = CALLBACK_URL;
  return fn().finally(() => {
    emp.callbackUrl = prev;
  });
}

async function slackApprove(a: ApprovalRequest) {
  const sc = await upsertNotificationChannel({ orgId: DEMO_ORG.id, provider: "slack", label: "Handoff Slack", enabled: true,
    config: { channelId: "C_FIXTURE" }, secrets: { botToken: "xoxb-fixture", signingSecret: "fixture-slack-secret" } });
  await recordNotificationDelivery({ approval: a, channelId: sc.id, provider: "slack", externalMessageId: "123.45", context: { channel: "C_FIXTURE" } });
  const raw = JSON.stringify({ type: "block_actions", user: { id: "U_APPROVER" }, channel: { id: "C_FIXTURE" }, message: { ts: "123.45" },
    actions: [{ action_id: "staffpass_reject", value: a.telegramRef }] });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", "fixture-slack-secret").update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  await slackRef(new Request("https://fixture.invalid/webhook", { method: "POST", headers: { "content-type": "application/json",
    "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, body: raw }), { params: Promise.resolve({ ref: sc.webhookRef }) });
}

async function lineApprove(a: ApprovalRequest) {
  const lc = await upsertNotificationChannel({ orgId: DEMO_ORG.id, provider: "line", label: "Handoff LINE", enabled: true,
    config: { destinationId: "G_FIXTURE" }, secrets: { channelAccessToken: "fixture-line-token", channelSecret: "fixture-line-secret" } });
  await recordNotificationDelivery({ approval: a, channelId: lc.id, provider: "line", externalMessageId: "77", context: {} });
  const raw = JSON.stringify({ events: [{ webhookEventId: `fixture-line-${a.id}`, type: "postback", source: { groupId: "G_FIXTURE", userId: "L1" }, postback: { data: `r:${a.telegramRef}` } }] });
  await lineRef(new Request("https://fixture.invalid/webhook", { method: "POST",
    headers: { "x-line-signature": createHmac("sha256", "fixture-line-secret").update(raw).digest("base64") }, body: raw }),
  { params: Promise.resolve({ ref: lc.webhookRef }) });
}

async function telegramApprove(a: ApprovalRequest) {
  const tc = await upsertNotificationChannel({ orgId: DEMO_ORG.id, provider: "telegram", label: "Handoff Telegram", enabled: true,
    config: { chatId: "-10042" }, secrets: { botToken: "fixture-telegram-token", webhookSecret: "fixture-telegram-secret" } });
  await recordNotificationDelivery({ approval: a, channelId: tc.id, provider: "telegram", externalMessageId: "77", context: {} });
  await telegramRef(new Request("https://fixture.invalid/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "fixture-telegram-secret" },
    body: JSON.stringify({ callback_query: { id: "fixture", data: `r:${a.telegramRef}`, from: { id: 42 }, message: { message_id: 77, chat: { id: -10042 } } } }) }),
  { params: Promise.resolve({ ref: tc.webhookRef }) });
}

const APPROVAL_CASES: Array<{ name: string; surface: string; run: (a: ApprovalRequest) => Promise<void> }> = [
  { name: "Slack approval ([ref] webhook)", surface: "slack", run: slackApprove },
  { name: "LINE approval ([ref] webhook)", surface: "line", run: lineApprove },
  { name: "Telegram approval ([ref] webhook)", surface: "telegram", run: telegramApprove },
];

describe("approval.resolved wake (Slack / LINE / Telegram) goes through the shared handoff", () => {
  for (const c of APPROVAL_CASES) {
    test(`${c.name}: flag ON → callback carries mcpHandoff (surface=${c.surface}) and wake audit`, async () => {
      process.env[FLAG] = "true";
      await withCallbackUrl(async () => {
        const a = await pendingApproval();
        await c.run(a);
        const cbs = callbackCalls();
        expect(cbs.length).toBe(1);
        expect(cbs[0].type).toBe("approval.resolved");
        expect(cbs[0].approvalId).toBe(a.id);
        assertHandoff(cbs[0], c.surface, "approval_resolved", "rejected");
        const json = JSON.stringify(cbs[0].mcpHandoff);
        expect(json).not.toContain("fixture-line-token");
        expect(json).not.toContain("fixture-telegram-token");
        expect(json).not.toContain("xoxb-fixture");
        const wakeAudit = getRuntimeAudit().find((e) => e.action === "agent.approval_wake" && e.metadata?.approvalId === a.id);
        expect(wakeAudit?.metadata).toMatchObject({ reason: "woke", surface: c.surface, mcpHandoff: true });
      });
    });

    test(`${c.name}: flag OFF → callback payload unchanged, no new audit`, async () => {
      delete process.env[FLAG];
      await withCallbackUrl(async () => {
        const a = await pendingApproval();
        await c.run(a);
        const cbs = callbackCalls();
        expect(cbs.length).toBe(1);
        expect("mcpHandoff" in cbs[0]).toBe(false);
        expect(getRuntimeAudit().some((e) => e.action === "agent.approval_wake" && e.metadata?.approvalId === a.id)).toBe(false);
      });
    });
  }

  for (const surface of ["web", "admin_proxy"] as const) {
    test(`${surface}: side effects with surface=${surface} carry the same block (callback + machine email)`, async () => {
      process.env[FLAG] = "true";
      const emp = getRuntimeEmployees().find((item) => item.id === "emp_sales")!;
      const a = await pendingApproval();
      await runApprovalResolveSideEffects({
        approval: { ...a, status: "rejected", resolvedAt: new Date().toISOString() },
        decision: "rejected",
        actorEmail: "approver@example.invalid",
        employee: { ...emp, callbackUrl: CALLBACK_URL },
        surface,
      });
      const cbs = callbackCalls();
      expect(cbs.length).toBe(1);
      assertHandoff(cbs[0], surface, "approval_resolved", "rejected");
    });
  }

  test("callback HTTP failure records wake_failed (never counted as a delivered wake)", async () => {
    process.env[FLAG] = "true";
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_sales")!;
    const a = await pendingApproval();
    await runApprovalResolveSideEffects({
      approval: { ...a, status: "rejected" }, decision: "rejected", actorEmail: "x@example.invalid",
      employee: { ...emp, callbackUrl: CALLBACK_URL }, surface: "line",
    });
    const wakeAudit = getRuntimeAudit().find((e) => e.action === "agent.approval_wake" && e.metadata?.approvalId === a.id);
    expect(wakeAudit?.metadata?.reason).toBe("wake_failed");
  });

  test("machine-readable approval email carries the endpoint lines (flag ON) and not when OFF", async () => {
    const { buildApprovalMachineBodyForTests } = await import("@/lib/approvals/resolve-side-effects");
    const a = await pendingApproval();
    delete process.env[FLAG];
    expect(buildApprovalMachineBodyForTests(a, "rejected", "x@example.invalid")).not.toContain("mcpEndpoint=");
    process.env[FLAG] = "true";
    const body = buildApprovalMachineBodyForTests(a, "rejected", "x@example.invalid");
    expect(body).toContain(`mcpEndpoint=${MCP_URL}`);
    expect(body).toContain("mcpConnectivityCheck=staffpass_whoami");
    expect(body).toContain("mcpHandoffSchema=staffpass.mcp_handoff.v1");
  });
});

describe("not-connected next step reaches Slack / LINE / Telegram mouths alike", () => {
  const PROVIDERS = [
    { provider: "slack" as const, employeeId: "emp_ops", api: "https://slack.com/api/chat.postMessage",
      config: { channelId: "C_MOUTH" }, secrets: { botToken: "xoxb-mouth", signingSecret: "s" } },
    { provider: "line" as const, employeeId: "emp_sns", api: "https://api.line.me/",
      config: { destinationId: "G_MOUTH" }, secrets: { channelAccessToken: "line-mouth", channelSecret: "s" } },
    { provider: "telegram" as const, employeeId: "emp_comm", api: "https://api.telegram.org/",
      config: { chatId: "-10099" }, secrets: { botToken: "tg-mouth", webhookSecret: "s" } },
  ];

  for (const p of PROVIDERS) {
    test(`${p.provider} mouth: one next-step notice with the endpoint; deduped; no re-wake`, async () => {
      process.env[FLAG] = "true";
      const employeeId = p.employeeId;
      const mouth = await upsertNotificationChannel({ orgId: DEMO_ORG.id, provider: p.provider, label: `Mouth ${p.provider}`,
        enabled: true, config: p.config, secrets: p.secrets });
      await setOrgStuckWatchPolicy(DEMO_ORG.id, { notifyMouth: mouth.id });
      const wakeAt = Date.now() - 20 * 60_000;
      pushRuntimeAuditEvent({
        orgId: DEMO_ORG.id, employeeId, credentialId: null, action: "agent.approval_wake", purpose: "approval.resolved",
        summary: "wake", createdAt: new Date(wakeAt).toISOString(),
        metadata: { reason: "woke", surface: p.provider, mcpHandoff: true, approvalId: `apr_${p.provider}` },
      });
      const first = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id);
      const mine = first.filter((r) => r.employeeId === employeeId);
      expect(mine.length).toBe(1);
      expect(mine[0].notified).toBe(true);
      const sent = calls.filter((c) => c.url.startsWith(p.api));
      expect(sent.length).toBe(1);
      expect(sent[0].body).toContain(MCP_URL);
      expect(sent[0].body).toContain("staffpass_whoami");
      expect(sent[0].body).toContain(employeeId);
      expect(calls.some((c) => c.url === WAKE_URL || c.url === CALLBACK_URL)).toBe(false);
      const notify = getRuntimeAudit().find((e) => e.action === "mcp_handoff.not_connected_notify" && e.employeeId === employeeId);
      expect(notify?.metadata?.surface).toBe(p.provider);
      expect(notify?.metadata?.mouthDelivered).toBe(true);

      calls = [];
      const second = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id);
      expect(second.filter((r) => r.employeeId === employeeId).length).toBe(0);
      expect(calls.filter((c) => c.url.startsWith(p.api)).length).toBe(0);
    });
  }

  test("flag OFF → watcher is a no-op", async () => {
    delete process.env[FLAG];
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_nc_off", credentialId: null, action: "slack.mention_wake", purpose: "slack.mention",
      summary: "wake", createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      metadata: { reason: "woke", surface: "slack", mcpHandoff: true, channel: "C1", ts: "1.2" },
    });
    expect(await processMcpNotConnectedWatchForOrg(DEMO_ORG.id)).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("bot that called MCP after the wake is not flagged (no false positive)", async () => {
    process.env[FLAG] = "true";
    const employeeId = "emp_sales";
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId, credentialId: null, action: "slack.user_token_im_wake", purpose: "slack.internal_im",
      summary: "wake", createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      metadata: { reason: "woke", surface: "slack", mcpHandoff: true, channel: "D1", ts: "1.3" },
    });
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId, credentialId: "cred_c", action: "mcp.client_seen", purpose: "mcp",
      summary: "seen", createdAt: new Date(Date.now() - 18 * 60_000).toISOString(), metadata: { method: "tools/call" },
    });
    const results = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id);
    expect(results.filter((r) => r.employeeId === employeeId).length).toBe(0);
  });
});

