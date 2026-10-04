/**
 * D9 (八坂 GO 2026-10-05): the approval.resolved callback (employee.callbackUrl).
 * WEBHOOK_HARDENING_ENABLED OFF → the receiver sees exactly today's request
 * (fetch, same body bytes, same headers); only the approver-facing result /
 * audit loses raw error text and the receiver's status (category only).
 * ON → #267 postWebhook (https:443 only, every DNS answer public, pinned,
 * no redirects), Standard Webhooks signature, minimal body by default,
 * legacy_full only when the config opts in, webhook-id = MCP Events eventId
 * when there is one (D7 dedupe). Demo mode, fake receiver, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-webhooks";

const { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } = await import("@/lib/demo-data");
const { createApproval, resolveApproval } = await import("@/lib/data/approvals");
const { updateWakeWebhook } = await import("@/lib/data");
const { runApprovalResolveSideEffects } = await import("@/lib/approvals/resolve-side-effects");
const ob = await import("@/lib/webhooks/outbound");
const settings = await import("@/lib/webhooks/settings");
const { verifyStandardWebhook } = await import("@/lib/mcp-events/standard-webhooks");
type PinnedRequest = import("@/lib/mcp-events/transport").PinnedRequest;

const ORG = DEMO_ORG.id;
const CB = "https://callback.example.com/staffpass/hook?k=1";
const ENV = ["WEBHOOK_HARDENING_ENABLED", "MCP_EVENTS_ENABLED", "MCP_ENDPOINT_HANDOFF_ENABLED", "NEXT_PUBLIC_APP_URL"];
const saved: Record<string, string | undefined> = {};
type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () => new Response("{}", { status: 200 });
const sent: PinnedRequest[] = [];
let dns = [{ address: "93.184.216.34", family: 4 as const }];
let receiverStatus = 200;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  fetchCalls = []; sent.length = 0; receiverStatus = 200;
  dns = [{ address: "93.184.216.34", family: 4 }];
  fetchImpl = async () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init || {} });
    return fetchImpl(String(input), init || {});
  }) as typeof fetch;
  ob.__setOutboundWebhookTransportForTests({
    lookup: async () => dns,
    request: async (r) => { sent.push(r); return { status: receiverStatus, body: Buffer.from("receiver internal detail 10.1.2.3") }; },
  });
  settings.__resetWebhookSettingsForTests();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  ob.__setOutboundWebhookTransportForTests(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await updateWakeWebhook("emp_sales", { orgId: ORG, url: null, secret: "" });
});

const employee = () => ({ ...getRuntimeEmployees().find((e) => e.id === "emp_sales")!, callbackUrl: CB });
async function decided(status: "approved" | "rejected" | "revision_requested" = "approved") {
  const { approval } = await createApproval({
    orgId: ORG, employeeId: "emp_sales", credentialId: "cred_t", title: "SECRET SUBJECT", purpose: "mail.send",
    summary: "CONFIDENTIAL SUMMARY", risk: "high", tool: "mail.send", jobId: "job_d9",
  });
  return (await resolveApproval(approval.id, status, "web:approver@example.com", ORG, status === "revision_requested" ? { revisionNote: "SECRET NOTE" } : {}))!;
}
const run = async (approval: Awaited<ReturnType<typeof decided>>, decision: "approved" | "rejected" | "revision_requested" = "approved") =>
  runApprovalResolveSideEffects({ approval, decision, actorEmail: "approver@example.com", employee: employee(), surface: "web" });
const legacyBody = (a: Awaited<ReturnType<typeof decided>>, status = "approved") => JSON.stringify({
  type: "approval.resolved", status, approvalId: a.id, employeeId: a.employeeId, tool: a.tool ?? null, jobId: a.jobId ?? null,
  purpose: a.purpose, risk: a.risk, title: a.title || a.summary.slice(0, 80), summary: a.summary, resolvedBy: "approver@example.com",
  resolvedAt: a.resolvedAt, revisionNote: a.revisionNote, revisionCount: a.revisionCount, parentApprovalId: a.parentApprovalId,
});
const cbFetches = () => fetchCalls.filter((c) => c.url === CB);
const wakeAudit = (id: string) => getRuntimeAudit().find((e) => e.action === "agent.approval_wake" && e.metadata?.approvalId === id);

describe("flag OFF (default): the receiver sees exactly today's request", () => {
  test("fetch, same URL / method / headers / body bytes; hardened transport never used", async () => {
    const a = await decided();
    const r = await run(a);
    expect(cbFetches()).toHaveLength(1);
    const { init } = cbFetches()[0];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "user-agent": "Staffpass-ApprovalHook/1.0" });
    expect(init.body).toBe(legacyBody(a));
    expect(init.redirect).toBeUndefined();
    expect(init.signal).toBeTruthy();
    expect(sent).toHaveLength(0);
    expect(r.callback).toEqual({ ok: true, skipped: false });
  });
  test("approver-facing result: category only — no raw error text, no receiver status", async () => {
    fetchImpl = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:443"), { code: "ECONNREFUSED" }) }); };
    let r = await run(await decided());
    expect(r.callback).toEqual({ ok: false, skipped: false, error: "connection_failed" });
    fetchImpl = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
    r = await run(await decided());
    expect(r.callback).toEqual({ ok: false, skipped: false, error: "timeout" });
    fetchImpl = async () => new Response("internal admin panel", { status: 403 });
    r = await run(await decided());
    expect(r.callback).toEqual({ ok: false, skipped: false, error: "http_4xx" });
    expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|aborted|admin panel|403/);
  });
  test("wake audit (handoff on) records the category, not the receiver status", async () => {
    process.env.MCP_ENDPOINT_HANDOFF_ENABLED = "true";
    process.env.NEXT_PUBLIC_APP_URL = "https://staffpass.example.test";
    fetchImpl = async () => new Response("no", { status: 502 });
    const a = await decided();
    await run(a);
    const audit = wakeAudit(a.id);
    expect(audit?.metadata).toMatchObject({ reason: "wake_failed", category: "http_5xx" });
    expect(audit?.metadata && "status" in audit.metadata).toBe(false);
  });
});

describe("flag ON: hardened delivery", () => {
  beforeEach(() => { process.env.WEBHOOK_HARDENING_ENABLED = "true"; });

  test("goes through the pinned transport (never fetch); minimal body = ids + status only", async () => {
    const a = await decided();
    const r = await run(a);
    expect(cbFetches()).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ address: "93.184.216.34", hostname: "callback.example.com", path: "/staffpass/hook?k=1", timeoutMs: 4000, userAgent: "Staffpass-ApprovalHook/1.0" });
    const body = JSON.parse(sent[0].body.toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["approvalId", "employeeId", "jobId", "parentApprovalId", "resolvedAt", "revisionCount", "risk", "status", "tool", "type"]);
    expect(body).toMatchObject({ type: "approval.resolved", status: "approved", approvalId: a.id, employeeId: "emp_sales" });
    expect(sent[0].body.toString()).not.toMatch(/SECRET SUBJECT|CONFIDENTIAL SUMMARY|approver@example\.com|SECRET NOTE/);
    expect(r.callback).toEqual({ ok: true, skipped: false });
  });
  test("revision request: still no revision note / approver in the minimal body", async () => {
    const a = await decided("revision_requested");
    await run(a, "revision_requested");
    expect(sent[0].body.toString()).not.toMatch(/SECRET NOTE|approver@example\.com/);
  });
  test("legacy_full is opt-in per config: exactly today's body bytes, still hardened + signed", async () => {
    await settings.setCallbackPayloadMode("emp_sales", ORG, "legacy_full");
    const { secret } = await settings.mintCallbackSigningSecret("emp_sales", ORG);
    const a = await decided();
    await run(a);
    expect(sent[0].body.toString("utf8")).toBe(legacyBody(a));
    const key = ob.signingKeyFromSecret(secret)!;
    const h = sent[0].headers;
    expect(verifyStandardWebhook(key, { id: h["webhook-id"], timestamp: h["webhook-timestamp"], signature: h["webhook-signature"] }, sent[0].body.toString("utf8"))).toBe(true);
  });
  test("signing key: dedicated callback secret → else the existing wake secret → else unsigned (id + timestamp only)", async () => {
    let a = await decided();
    await run(a);
    expect(sent[0].headers["webhook-signature"]).toBeUndefined();
    expect(sent[0].headers["webhook-id"]).toMatch(/^msg_cb_[0-9a-f]{32}$/);
    expect(sent[0].headers.authorization).toBeUndefined();
    await updateWakeWebhook("emp_sales", { orgId: ORG, url: "https://wake.example.com/w", secret: "sender-key-d9" });
    a = await decided();
    await run(a);
    const h1 = sent[1].headers;
    expect(verifyStandardWebhook(ob.signingKeyFromSecret("sender-key-d9")!, { id: h1["webhook-id"], timestamp: h1["webhook-timestamp"], signature: h1["webhook-signature"] }, sent[1].body.toString())).toBe(true);
    expect(h1.authorization).toBeUndefined(); // the wake Bearer is never sent to the callback receiver
    const { secret } = await settings.mintCallbackSigningSecret("emp_sales", ORG);
    a = await decided();
    await run(a);
    const h2 = sent[2].headers;
    expect(verifyStandardWebhook(ob.signingKeyFromSecret(secret)!, { id: h2["webhook-id"], timestamp: h2["webhook-timestamp"], signature: h2["webhook-signature"] }, sent[2].body.toString())).toBe(true);
    expect(verifyStandardWebhook(ob.signingKeyFromSecret("sender-key-d9")!, { id: h2["webhook-id"], timestamp: h2["webhook-timestamp"], signature: h2["webhook-signature"] }, sent[2].body.toString())).toBe(false);
  });
  test("D7: with MCP Events on, webhook-id = body eventId = the MCP Events eventId (one id per decision)", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const a = await decided();
    await run(a);
    const body = JSON.parse(sent[0].body.toString()) as { eventId?: string };
    expect(body.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(sent[0].headers["webhook-id"]).toBe(body.eventId!);
  });
  test("same decision delivered twice → same webhook-id (receiver dedupe without MCP Events)", async () => {
    const a = await decided();
    await run(a);
    await run(a);
    expect(sent).toHaveLength(2);
    expect(sent[0].headers["webhook-id"]).toBe(sent[1].headers["webhook-id"]);
  });
  test("SSRF: private / metadata / mixed answers → address_blocked, nothing sent; http:// / IP literal / :8443 → invalid_url", async () => {
    for (const answers of [[{ address: "10.0.0.5", family: 4 as const }], [{ address: "169.254.169.254", family: 4 as const }], [{ address: "93.184.216.34", family: 4 as const }, { address: "127.0.0.1", family: 4 as const }]]) {
      dns = answers;
      const r = await run(await decided());
      expect(r.callback).toEqual({ ok: false, skipped: false, error: "address_blocked" });
    }
    expect(sent).toHaveLength(0);
    dns = [{ address: "93.184.216.34", family: 4 }];
    for (const url of ["http://callback.example.com/x", "https://10.0.0.5/x", "https://callback.example.com:8443/x"]) {
      const r = await runApprovalResolveSideEffects({ approval: await decided(), decision: "approved", actorEmail: "a@example.com", employee: { ...employee(), callbackUrl: url }, surface: "web" });
      expect(r.callback).toEqual({ ok: false, skipped: false, error: "invalid_url" });
    }
    expect(sent).toHaveLength(0);
    expect(cbFetches()).toHaveLength(0);
  });
  test("redirect is not followed; receiver status / body never surface", async () => {
    receiverStatus = 302;
    let r = await run(await decided());
    expect(r.callback).toEqual({ ok: false, skipped: false, error: "redirect_refused" });
    expect(sent).toHaveLength(1);
    receiverStatus = 500;
    r = await run(await decided());
    expect(r.callback).toEqual({ ok: false, skipped: false, error: "http_5xx" });
    expect(JSON.stringify(r)).not.toMatch(/receiver internal|10\.1\.2\.3|500/);
  });
  test("settings unreadable → not sent (fail closed), category config_unavailable", async () => {
    settings.__setWebhookSettingsFailureForTests(true);
    try {
      const r = await run(await decided());
      expect(r.callback).toEqual({ ok: false, skipped: false, error: "config_unavailable" });
      expect(sent).toHaveLength(0);
    } finally {
      settings.__setWebhookSettingsFailureForTests(false);
    }
  });
  test("handoff block survives in the minimal body; wake audit carries the category", async () => {
    process.env.MCP_ENDPOINT_HANDOFF_ENABLED = "true";
    process.env.NEXT_PUBLIC_APP_URL = "https://staffpass.example.test";
    dns = [{ address: "10.0.0.5", family: 4 }];
    const a = await decided();
    await run(a);
    expect(wakeAudit(a.id)?.metadata).toMatchObject({ reason: "wake_failed", category: "address_blocked" });
    dns = [{ address: "93.184.216.34", family: 4 }];
    const b = await decided();
    await run(b);
    const body = JSON.parse(sent[0].body.toString()) as Record<string, unknown>;
    expect(body.mcpHandoff).toBeTruthy();
    expect(wakeAudit(b.id)?.metadata).toMatchObject({ reason: "woke", hardened: true });
  });
});
