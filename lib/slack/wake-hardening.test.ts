/**
 * D9 (八坂 GO 2026-10-05): the conversation wake webhook (postWake, shared by
 * every Slack wake trigger). WEBHOOK_HARDENING_ENABLED OFF → exactly today's
 * request (fetch, Bearer <wake secret>, same body); only the audit loses raw
 * error text / receiver status (category only). ON → #267 postWebhook
 * (https:443, every answer public, pinned, no redirects) + Standard Webhooks
 * signature with the existing wake secret (Bearer kept for compatibility),
 * stable webhook-id per Slack event. Demo mode, fake receiver, no network.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } = await import("@/lib/demo-data");
const { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { updateWakeWebhook } = await import("@/lib/data");
const { handleSlackEventsRequest } = await import("@/lib/slack/mention-ingress");
const ob = await import("@/lib/webhooks/outbound");
const { verifyStandardWebhook } = await import("@/lib/mcp-events/standard-webhooks");
type PinnedRequest = import("@/lib/mcp-events/transport").PinnedRequest;

const SIGNING_SECRET = "slack-events-signing-secret-for-d9";
const WAKE_URL = "https://wake.example.com/hook";
const WAKE_SECRET = "sender-key-d9-wake";
const BOUND_USER = "U_D9WAKE";
const TEAM = "T_DEMO";
const ENV = ["WEBHOOK_HARDENING_ENABLED", "SLACK_SIGNING_SECRET", "MCP_ENDPOINT_HANDOFF_ENABLED"];
const saved: Record<string, string | undefined> = {};
type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchImpl: () => Promise<Response> = async () => Response.json({ ok: true });
const sent: PinnedRequest[] = [];
let dns = [{ address: "93.184.216.34", family: 4 as const }];
let receiverStatus = 200;
const originalFetch = globalThis.fetch;
let restoreEmp: (() => Promise<void>) | null = null;

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.WEBHOOK_HARDENING_ENABLED; delete process.env.MCP_ENDPOINT_HANDOFF_ENABLED;
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  fetchCalls = []; sent.length = 0; receiverStatus = 200; dns = [{ address: "93.184.216.34", family: 4 }];
  fetchImpl = async () => Response.json({ ok: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init || {} });
    return String(input) === WAKE_URL ? fetchImpl() : Response.json({ ok: true });
  }) as typeof fetch;
  ob.__setOutboundWebhookTransportForTests({
    lookup: async () => dns,
    request: async (r) => { sent.push(r); return { status: receiverStatus, body: Buffer.from("receiver detail 10.9.9.9") }; },
  });
  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: BOUND_USER }];
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
  await bindEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id, slackUserId: BOUND_USER, slackTeamId: TEAM, displayName: "D9", userToken: "xoxp-test" });
  await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: WAKE_URL, secret: WAKE_SECRET });
  restoreEmp = async () => {
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: null, secret: "" });
    emp.allowedAccounts = previous;
  };
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  ob.__setOutboundWebhookTransportForTests(null);
  await restoreEmp?.();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function mention(eventId = `Ev_d9_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`) {
  const body = { type: "event_callback", team_id: TEAM, event_id: eventId,
    event: { type: "message", user: "U_HUMAN_D9", text: `<@${BOUND_USER}> お願い`, ts: "1787911800.200001", channel: "C_D9" } };
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  await handleSlackEventsRequest({ rawBody, timestamp, signature });
  return eventId;
}
const wakeFetches = () => fetchCalls.filter((c) => c.url === WAKE_URL);
const failAudit = (eventId: string) => getRuntimeAudit().find((e) => e.action === "slack.mention_wake" && e.metadata?.eventId === eventId && e.metadata?.reason === "wake_failed");

describe("flag OFF (default): exactly today's wake request", () => {
  test("fetch with Bearer <wake secret>; hardened transport unused", async () => {
    await mention();
    expect(wakeFetches()).toHaveLength(1);
    const { init } = wakeFetches()[0];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${WAKE_SECRET}` });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ channel: "C_D9", text: `<@${BOUND_USER}> お願い`, employeeId: "emp_comm" });
    expect(sent).toHaveLength(0);
  });
  test("audit on failure: category only (no raw error text, no receiver status)", async () => {
    fetchImpl = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:443"), { code: "ECONNREFUSED" }) }); };
    let id = await mention();
    expect(failAudit(id)?.metadata).toMatchObject({ reason: "wake_failed", category: "connection_failed" });
    expect(JSON.stringify(failAudit(id)?.metadata)).not.toMatch(/ECONNREFUSED|10\.0\.0\.9|fetch failed/);
    fetchImpl = async () => new Response("internal", { status: 404 });
    id = await mention();
    expect(failAudit(id)?.metadata).toMatchObject({ reason: "wake_failed", category: "http_4xx" });
    expect(failAudit(id)?.metadata && "status" in failAudit(id)!.metadata!).toBe(false);
  });
});

describe("flag ON: hardened wake", () => {
  beforeEach(() => { process.env.WEBHOOK_HARDENING_ENABLED = "true"; });
  test("pinned transport, Bearer kept, Standard Webhooks signature with the wake secret, same body as before", async () => {
    await mention();
    expect(wakeFetches()).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ address: "93.184.216.34", hostname: "wake.example.com", path: "/hook", timeoutMs: 10_000, userAgent: "Staffpass-Wake/1.0" });
    const h = sent[0].headers;
    expect(h.authorization).toBe(`Bearer ${WAKE_SECRET}`);
    expect(h["webhook-id"]).toMatch(/^msg_wake_[0-9a-f]{32}$/);
    const raw = sent[0].body.toString("utf8");
    expect(verifyStandardWebhook(Buffer.from(WAKE_SECRET, "utf8"), { id: h["webhook-id"], timestamp: h["webhook-timestamp"], signature: h["webhook-signature"] }, raw)).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({ channel: "C_D9", employeeId: "emp_comm", text: `<@${BOUND_USER}> お願い` });
    expect(getRuntimeAudit().some((e) => e.action === "slack.mention_wake" && e.metadata?.reason === "woke" && e.metadata?.hardened === true)).toBe(true);
  });
  test("private / metadata answer → not sent, audit wake_failed address_blocked", async () => {
    dns = [{ address: "169.254.169.254", family: 4 }];
    const id = await mention();
    expect(sent).toHaveLength(0);
    expect(wakeFetches()).toHaveLength(0);
    expect(failAudit(id)?.metadata).toMatchObject({ reason: "wake_failed", category: "address_blocked" });
  });
  test("redirect not followed; 5xx → category only", async () => {
    receiverStatus = 307;
    let id = await mention();
    expect(sent).toHaveLength(1);
    expect(failAudit(id)?.metadata).toMatchObject({ category: "redirect_refused" });
    receiverStatus = 503;
    id = await mention();
    expect(failAudit(id)?.metadata).toMatchObject({ category: "http_5xx" });
    expect(JSON.stringify(failAudit(id)?.metadata)).not.toMatch(/receiver detail|10\.9\.9\.9|503/);
  });
  test("non-443 / http wake URL → invalid_url, nothing sent", async () => {
    await updateWakeWebhook("emp_comm", { orgId: DEMO_ORG.id, url: "https://wake.example.com:8443/hook", secret: WAKE_SECRET });
    const id = await mention();
    expect(sent).toHaveLength(0);
    expect(failAudit(id)?.metadata).toMatchObject({ category: "invalid_url" });
  });
  test("no wake secret → no Bearer, no signature (id + timestamp only)", async () => {
    await updateWakeWebhook("emp_comm", { orgId: DEMO_ORG.id, url: WAKE_URL, secret: "" });
    await mention();
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.authorization).toBeUndefined();
    expect(sent[0].headers["webhook-signature"]).toBeUndefined();
    expect(sent[0].headers["webhook-id"]).toMatch(/^msg_wake_/);
  });
});
