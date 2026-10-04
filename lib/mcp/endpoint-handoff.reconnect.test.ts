/**
 * #254 follow-up 4: the not-connected notice is the LAST resort, with exactly one action.
 *
 * Stages (per employee, flag MCP_ENDPOINT_HANDOFF_ENABLED):
 *  0. wake carries the handoff block (#254).
 *  1. watcher sees "woken, no MCP activity" → arms a reconnect prompt (audit only, nobody notified,
 *     nothing re-woken). The NEXT wake on any channel carries reconnectRequired + a stronger prompt.
 *  2. only if that reconnect wake is also not followed by MCP activity (10 min), or no further wake
 *     arrives within MCP_RECONNECT_ESCALATE_MS, a human gets ONE notice (24h cooldown, as before).
 * Same notice text on Slack / LINE / Telegram; only escaping differs. All HTTP is mocked.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuditEvent } from "@/lib/types";
import type { McpHandoff } from "@/lib/mcp/endpoint-handoff";

const { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees, pushRuntimeAuditEvent } = await import("@/lib/demo-data");
const {
  MCP_RECONNECT_ARMED_ACTION,
  MCP_RECONNECT_ESCALATE_MS,
  buildNotConnectedNotice,
  getMcpConnectionState,
  mcpHandoffWakeAuditMeta,
  processMcpNotConnectedWatchForOrg,
  renderNotConnectedNotice,
  resetMcpClientSeenThrottleForTests,
  withMcpHandoff,
} = await import("@/lib/mcp/endpoint-handoff");
const { upsertNotificationChannel } = await import("@/lib/data/notification-channels");
const { setOrgStuckWatchPolicy, resetDemoStuckWatchPolicy } = await import("@/lib/data/stuck-watch-policy");
const { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { updateWakeWebhook } = await import("@/lib/data");
const { handleSlackEventsRequest } = await import("@/lib/slack/mention-ingress");
const { createApproval } = await import("@/lib/data/approvals");
const { runApprovalResolveSideEffects } = await import("@/lib/approvals/resolve-side-effects");

const FLAG = "MCP_ENDPOINT_HANDOFF_ENABLED";
const ORIGIN = "https://reconnect.example.test";
const MCP_URL = `${ORIGIN}/api/mcp`;
const MIN = 60_000;
const WAKE_URL = "https://example.test/wake/reconnect";
const CALLBACK_URL = "https://example.test/callback/reconnect";
const SIGNING_SECRET = "reconnect-signing-secret";
const SECRET_PATTERNS = [/gb_(emp|adm)_[A-Za-z0-9]/, /xox[abpr]-/, /[A-Za-z0-9_-]{32,}/, /token=/i, /statusToken/i];

type Call = { url: string; body: string };
let calls: Call[] = [];
let savedFetch: typeof fetch;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [FLAG, "NEXT_PUBLIC_APP_URL", "SLACK_SIGNING_SECRET"];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  getRuntimeAudit().splice(0);
  resetMcpClientSeenThrottleForTests();
  savedFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body || "") });
    return Response.json({ ok: true, channel: "C_FIX", ts: "1.2", result: { message_id: 7 } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetDemoStuckWatchPolicy();
});

function decode(format: "slack" | "telegram" | "line", text: string): string {
  if (format === "line") return text;
  let t = text;
  if (format === "slack") t = t.replace(/^```\n?/gm, "").replace(/\n?```$/gm, "");
  if (format === "telegram") t = t.replace(/<\/?code>/g, "");
  return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function pushWake(employeeId: string, at: number, extra: Record<string, unknown> = {}): AuditEvent {
  return pushRuntimeAuditEvent({
    orgId: DEMO_ORG.id, employeeId, credentialId: null, action: "slack.mention_wake", purpose: "slack.mention",
    summary: "wake", createdAt: new Date(at).toISOString(),
    metadata: { reason: "woke", surface: "slack", mcpHandoff: true, channel: "C_RC", ts: String(at / 1000), ...extra },
  });
}

describe("the one-action notice", () => {
  const n = () => buildNotConnectedNotice({ employeeId: "emp_ops", displayName: "運用<!channel>&*太郎*", surface: "line", minutesSinceWake: 25 });

  test("exactly one action: send this one line to this employee's AI agent chat", () => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    const notice = n();
    expect(notice.action).toContain("1 つ");
    expect(notice.action).toContain("次の 1 行");
    expect(notice.action).toContain("この社員（運用!channel*太郎*）の AI エージェントのチャット");
    expect(notice.action).not.toMatch(/grok/i);
    expect(notice.copyLine).not.toContain("\n");
    expect(notice.copyLine).toContain(MCP_URL);
    expect(notice.copyLine).toContain("staffpass_whoami");
    expect(notice.copyLine).toContain("employeeId=emp_ops");
    // Only one numbered/ordered step list is gone; no "1. 2. 3." multi-step instructions.
    const plain = renderNotConnectedNotice(notice, "plain");
    expect(plain).not.toMatch(/^\s*[23]\.\s/m);
  });

  test("the copyable line contains no secret", () => {
    const notice = n();
    for (const p of SECRET_PATTERNS) expect({ p: String(p), hit: p.test(notice.copyLine) }).toEqual({ p: String(p), hit: false });
    expect(renderNotConnectedNotice(notice, "plain")).not.toMatch(/gb_emp_[A-Za-z0-9]/);
  });

  test("same text on Slack / LINE / Telegram — only escaping differs", () => {
    const notice = n();
    const plain = renderNotConnectedNotice(notice, "plain");
    const slack = renderNotConnectedNotice(notice, "slack");
    const telegram = renderNotConnectedNotice(notice, "telegram");
    const line = renderNotConnectedNotice(notice, "line");
    expect(decode("slack", slack)).toBe(plain);
    expect(decode("telegram", telegram)).toBe(plain);
    expect(decode("line", line)).toBe(plain);
    // The one line is presented copyable as-is on each channel.
    expect(slack).toContain("```\n" + notice.copyLine + "\n```");
    expect(telegram).toContain(`<code>${notice.copyLine}</code>`);
    expect(line.split("\n")).toContain(notice.copyLine);
    // Name cannot inject mentions / markup.
    expect(slack).not.toContain("<!channel>");
    expect(telegram).not.toMatch(/<(?!\/?code>)/);
  });
});

describe("stage 1: reconnect prompt on the next wake (no human, no re-wake)", () => {
  test("flag ON: watcher arms instead of notifying; next wake carries reconnectRequired", async () => {
    process.env[FLAG] = "true";
    const t0 = Date.now();
    pushWake("emp_ops", t0 - 20 * MIN);
    const results = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id);
    const mine = results.filter((r) => r.employeeId === "emp_ops");
    expect(mine.length).toBe(1);
    expect(mine[0].stage).toBe("armed");
    expect(mine[0].notified).toBe(false);
    expect(calls.length).toBe(0); // nobody notified, nothing re-woken
    expect(getRuntimeAudit().some((e) => e.action === MCP_RECONNECT_ARMED_ACTION && e.employeeId === "emp_ops")).toBe(true);
    expect(getRuntimeAudit().some((e) => e.action === "mcp_handoff.not_connected_notify")).toBe(false);

    const state = await getMcpConnectionState(DEMO_ORG.id, "emp_ops");
    expect(state.reconnectRequired).toBe(true);
    const body = await withMcpHandoff({ type: "wake" }, { orgId: DEMO_ORG.id, employeeId: "emp_ops", surface: "telegram", kind: "conversation", trigger: "t" });
    const h = body.mcpHandoff as McpHandoff;
    expect(h.reconnectRequired).toBe(true);
    expect(h.reconnectPromptJa).toContain(MCP_URL);
    expect(h.reconnectPromptJa).toContain("staffpass_whoami");
    expect(mcpHandoffWakeAuditMeta(body, "telegram")).toMatchObject({ mcpHandoff: true, surface: "telegram", mcpReconnectRequired: true });

    // Second run before anything changes: nothing new (bounded, no loop).
    const again = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id);
    expect(again.filter((r) => r.employeeId === "emp_ops").length).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("connected after arming → reconnect flag clears; no notice ever", async () => {
    process.env[FLAG] = "true";
    const t0 = Date.now();
    pushWake("emp_sales", t0 - 20 * MIN);
    await processMcpNotConnectedWatchForOrg(DEMO_ORG.id);
    pushRuntimeAuditEvent({ orgId: DEMO_ORG.id, employeeId: "emp_sales", credentialId: "cred_sales", action: "mcp.client_seen",
      purpose: "mcp", summary: "seen", createdAt: new Date(t0 + 1000).toISOString(), metadata: { method: "tools/call" } });
    expect((await getMcpConnectionState(DEMO_ORG.id, "emp_sales")).reconnectRequired).toBe(false);
    const later = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0 + 2 * MCP_RECONNECT_ESCALATE_MS) });
    expect(later.filter((r) => r.employeeId === "emp_sales").length).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("real Slack wake after arming carries the stronger prompt; its audit is marked", async () => {
    process.env[FLAG] = "true";
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: "U_RC_BOUND" }];
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    await bindEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id, slackUserId: "U_RC_BOUND", slackTeamId: "T_DEMO", displayName: "RC", userToken: "xoxp-rc" });
    await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: WAKE_URL, secret: "rc-wake-secret" });
    try {
      pushWake(emp.id, Date.now() - 20 * MIN);
      await processMcpNotConnectedWatchForOrg(DEMO_ORG.id);
      const raw = JSON.stringify({ type: "event_callback", team_id: "T_DEMO", event_id: `Ev_rc_${Date.now()}`,
        event: { type: "message", user: "U_RC_HUMAN", text: "<@U_RC_BOUND> お願い", ts: "1787912000.000100", channel: "C_RC_REAL" } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
      await handleSlackEventsRequest({ rawBody: raw, timestamp, signature });
      const wake = calls.filter((c) => c.url === WAKE_URL).map((c) => JSON.parse(c.body) as { mcpHandoff?: McpHandoff });
      expect(wake.length).toBe(1);
      expect(wake[0].mcpHandoff?.reconnectRequired).toBe(true);
      expect(JSON.stringify(wake[0].mcpHandoff)).not.toContain("rc-wake-secret");
      const audit = getRuntimeAudit().find((e) => e.action === "slack.mention_wake" && e.employeeId === emp.id && e.metadata?.channel === "C_RC_REAL");
      expect(audit?.metadata?.mcpReconnectRequired).toBe(true);
    } finally {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: null, secret: "" });
      emp.allowedAccounts = previous;
    }
  });

  test("approval.resolved wake after arming (LINE surface) carries the stronger prompt too", async () => {
    process.env[FLAG] = "true";
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_sales")!;
    // The approval was requested (with the badge) an hour ago; since then the bot went silent.
    const a = (await createApproval({ orgId: DEMO_ORG.id, employeeId: "emp_sales", credentialId: "cred_sales", title: "rc",
      purpose: "fixture", summary: "Fixture", risk: "low", tool: "comm.reply", jobId: crypto.randomUUID() })).approval;
    for (const e of getRuntimeAudit()) e.createdAt = new Date(Date.now() - 60 * MIN).toISOString();
    pushWake("emp_sales", Date.now() - 20 * MIN);
    const armed = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id);
    expect(armed.find((r) => r.employeeId === "emp_sales")?.stage).toBe("armed");
    await runApprovalResolveSideEffects({ approval: { ...a, status: "rejected" }, decision: "rejected",
      actorEmail: "line:approver", employee: { ...emp, callbackUrl: CALLBACK_URL }, surface: "line" });
    const cb = calls.filter((c) => c.url === CALLBACK_URL).map((c) => JSON.parse(c.body) as { mcpHandoff?: McpHandoff });
    expect(cb[0].mcpHandoff?.reconnectRequired).toBe(true);
    const wakeAudit = getRuntimeAudit().find((e) => e.action === "agent.approval_wake" && e.metadata?.approvalId === a.id);
    expect(wakeAudit?.metadata).toMatchObject({ mcpHandoff: true, surface: "line", mcpReconnectRequired: true });
  });
});

const PROVIDERS: Array<{ provider: "slack" | "line" | "telegram"; api: string; config: Record<string, string>; secrets: Record<string, string> }> = [
  { provider: "slack", api: "https://slack.com/api/chat.postMessage", config: { channelId: "C_RC_MOUTH" }, secrets: { botToken: "xoxb-rc-mouth", signingSecret: "s" } },
  { provider: "line", api: "https://api.line.me/", config: { destinationId: "G_RC_MOUTH" }, secrets: { channelAccessToken: "line-rc-mouth", channelSecret: "s" } },
  { provider: "telegram", api: "https://api.telegram.org/", config: { chatId: "-10077" }, secrets: { botToken: "tg-rc-mouth", webhookSecret: "s" } },
];

function sentText(provider: string, body: string): string {
  const json = JSON.parse(body) as { text?: string; messages?: Array<{ text: string }> };
  return provider === "line" ? String(json.messages?.[0]?.text || "") : String(json.text || "");
}

describe("stage 2: one human notice only if the reconnect wake also fails (Slack / LINE / Telegram)", () => {
  for (const p of PROVIDERS) {
    test(`${p.provider}: arm → reconnect wake → still silent 10 min → ONE notice, same text, then cooldown`, async () => {
      process.env[FLAG] = "true";
      const employeeId = "emp_ops";
      const mouth = await upsertNotificationChannel({ orgId: DEMO_ORG.id, provider: p.provider, label: `RC ${p.provider}`, enabled: true, config: p.config, secrets: p.secrets });
      await setOrgStuckWatchPolicy(DEMO_ORG.id, { notifyMouth: mouth.id });
      const t0 = Date.now();
      pushWake(employeeId, t0 - 20 * MIN);
      const armed = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0) });
      expect(armed.find((r) => r.employeeId === employeeId)?.stage).toBe("armed");
      expect(calls.length).toBe(0);

      // The next natural wake carried reconnectRequired (2 min after arming).
      pushWake(employeeId, t0 + 2 * MIN, { mcpReconnectRequired: true, surface: p.provider });
      const tooSoon = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0 + 8 * MIN) });
      expect(tooSoon.filter((r) => r.employeeId === employeeId).length).toBe(0);
      expect(calls.length).toBe(0);

      const notified = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0 + 13 * MIN) });
      const mine = notified.filter((r) => r.employeeId === employeeId);
      expect(mine.length).toBe(1);
      expect(mine[0].stage).toBe("notified");
      expect(mine[0].notified).toBe(true);
      const sent = calls.filter((c) => c.url.startsWith(p.api));
      expect(sent.length).toBe(1);
      expect(calls.some((c) => c.url === WAKE_URL || c.url === CALLBACK_URL)).toBe(false);

      const notice = buildNotConnectedNotice({ employeeId, displayName: getRuntimeEmployees().find((e) => e.id === employeeId)?.displayName,
        surface: p.provider, minutesSinceWake: 11, via: "reconnect_wake" });
      const text = sentText(p.provider, sent[0].body);
      expect(text).toBe(renderNotConnectedNotice(notice, p.provider));
      expect(decode(p.provider, text)).toBe(renderNotConnectedNotice(notice, "plain"));
      expect(text).not.toContain(String(p.secrets.botToken || p.secrets.channelAccessToken));

      const audit = getRuntimeAudit().find((e) => e.action === "mcp_handoff.not_connected_notify" && e.employeeId === employeeId);
      expect(audit?.metadata).toMatchObject({ stage: "notified", via: "reconnect_wake", surface: p.provider, mouthDelivered: true });

      calls = [];
      const after = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0 + 3 * MCP_RECONNECT_ESCALATE_MS) });
      expect(after.filter((r) => r.employeeId === employeeId).length).toBe(0);
      expect(calls.length).toBe(0);
    });
  }

  test("no follow-up wake: notice only after MCP_RECONNECT_ESCALATE_MS (bounded fallback), once", async () => {
    process.env[FLAG] = "true";
    const mouth = await upsertNotificationChannel({ orgId: DEMO_ORG.id, provider: "slack", label: "RC fb", enabled: true,
      config: { channelId: "C_RC_FB" }, secrets: { botToken: "xoxb-rc-fb", signingSecret: "s" } });
    await setOrgStuckWatchPolicy(DEMO_ORG.id, { notifyMouth: mouth.id });
    const t0 = Date.now();
    pushWake("emp_sns", t0 - 20 * MIN);
    await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0) });
    const early = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0 + MCP_RECONNECT_ESCALATE_MS - MIN) });
    expect(early.filter((r) => r.employeeId === "emp_sns").length).toBe(0);
    expect(calls.length).toBe(0);
    const late = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0 + MCP_RECONNECT_ESCALATE_MS + MIN) });
    expect(late.find((r) => r.employeeId === "emp_sns")).toMatchObject({ stage: "notified", notified: true });
    expect(calls.filter((c) => c.url.startsWith("https://slack.com/api/chat.postMessage")).length).toBe(1);
    const audit = getRuntimeAudit().find((e) => e.action === "mcp_handoff.not_connected_notify" && e.employeeId === "emp_sns");
    expect(audit?.metadata?.via).toBe("no_followup_wake");
  });

  test("flag OFF: watcher no-op, no arm, wake payload unchanged", async () => {
    delete process.env[FLAG];
    pushWake("emp_ops", Date.now() - 20 * MIN);
    expect(await processMcpNotConnectedWatchForOrg(DEMO_ORG.id)).toEqual([]);
    expect(getRuntimeAudit().some((e) => e.action === MCP_RECONNECT_ARMED_ACTION)).toBe(false);
    const raw = { type: "wake" };
    expect(await withMcpHandoff(raw, { orgId: DEMO_ORG.id, employeeId: "emp_ops", surface: "slack", kind: "conversation", trigger: "t" })).toBe(raw as never);
    expect(calls.length).toBe(0);
  });
});
