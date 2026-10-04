/**
 * MCP Events service (flag MCP_EVENTS_ENABLED): events/list|subscribe|unsubscribe,
 * approval.decided / approval.expired emit, signed delivery, retries with a stable
 * webhook-id, tenant isolation, payload minimality, immediate stop on revocation,
 * "what woke the AI" audit. Demo mode, dummy values, fake receiver (no network).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-mcpevents";
process.env.MCP_EVENTS_ENABLED = "true";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { getBinding, revokeBinding, rotateCredential, listAuditEvents } = await import("@/lib/data");
const { createApproval, resolveApproval } = await import("@/lib/data/approvals");
const { fingerprintSecret } = await import("@/lib/bindings");
const svc = await import("@/lib/mcp-events/service");
const store = await import("@/lib/mcp-events/store");
const { verifyStandardWebhook, parseWhsecSecret } = await import("@/lib/mcp-events/standard-webhooks");
type Cred = import("@/lib/auth/employee-credential").ResolvedEmployeeCredential;
type PinnedRequest = import("@/lib/mcp-events/transport").PinnedRequest;

const ORG = DEMO_ORG.id;
let clock = Date.parse("2026-10-05T01:00:00Z");
type Mode = "echo" | "wrong" | 500 | 503 | 410 | 200;
let mode: Mode = "echo";
let deliveryStatusQueue: number[] = [];
const posts: PinnedRequest[] = [];
let dnsAnswer = [{ address: "93.184.216.34", family: 4 as const }];

function receiver() {
  return {
    lookup: async () => dnsAnswer,
    request: async (req: PinnedRequest) => {
      posts.push(req);
      const body = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
      if (body.type === "verification") {
        if (mode === "echo") return { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
        if (mode === "wrong") return { status: 200, body: Buffer.from(JSON.stringify({ challenge: "nope" })) };
        return { status: Number(mode), body: Buffer.from("internal detail that must not leak") };
      }
      const status = deliveryStatusQueue.length ? deliveryStatusQueue.shift()! : 200;
      return { status, body: Buffer.from("") };
    },
  };
}

async function credFor(employeeId: string): Promise<Cred> {
  const b = await getBinding(employeeId);
  if (!b) throw new Error("no binding");
  return { employeeId, orgId: b.orgId, generation: b.credentialGeneration, credentialId: null, fingerprint: b.credentialFingerprint!, binding: b, secretPrefix: "gb_emp_" };
}
const whsec = () => `whsec_${randomBytes(32).toString("base64")}`;
const sub = (cred: Cred, over: Record<string, unknown> = {}, secret = whsec()) => svc.handleEventsSubscribe(cred, {
  name: "approval.decided", arguments: {}, delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/sales", secret }, cursor: null, ttlMs: 3_600_000, ...over,
});
const deliveriesTo = (path: string) => posts.filter((p) => p.path === path && !String(p.headers["webhook-id"]).startsWith("msg_verification_"));
async function newApproval(employeeId: string, risk: "low" | "medium" | "high" = "high") {
  const { approval } = await createApproval({
    orgId: ORG, employeeId, credentialId: "cred_test", title: "TOP SECRET TITLE", purpose: "mail.send",
    summary: "CONFIDENTIAL SUMMARY body text", risk, tool: "mail.send", jobId: `job_${Math.random().toString(36).slice(2, 8)}`,
  });
  return approval;
}
async function decide(employeeId: string, status: "approved" | "rejected" | "revision_requested" = "approved", risk: "low" | "medium" | "high" = "high") {
  const a = await newApproval(employeeId, risk);
  const resolved = await resolveApproval(a.id, status, "web:approver@example.com", ORG, status === "revision_requested" ? { revisionNote: "SECRET NOTE" } : {});
  if (!resolved) throw new Error("not resolved");
  return resolved;
}
const audits = async (action: string) => (await listAuditEvents(ORG, 1000)).filter((e) => e.action === action);

beforeEach(() => {
  store.__resetMcpEventsStoreForTests();
  svc.__setMcpEventsTransportForTests(receiver());
  svc.__setMcpEventsClockForTests(() => clock);
  posts.length = 0; mode = "echo"; deliveryStatusQueue = [];
  dnsAnswer = [{ address: "93.184.216.34", family: 4 }];
});
afterEach(() => { svc.__setMcpEventsTransportForTests(null); svc.__setMcpEventsClockForTests(null); });
afterAll(() => { delete process.env.MCP_EVENTS_ENABLED; });

describe("events/list", () => {
  test("lists approval.decided + approval.expired, webhook only, strict input schemas", async () => {
    const r = await svc.handleEventsList(await credFor("emp_sales"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = (r.result as { events: Array<Record<string, unknown>> }).events;
    expect(events.map((e) => e.name)).toEqual(["approval.decided", "approval.expired"]);
    for (const e of events) {
      expect(e.delivery).toEqual(["webhook"]);
      expect((e.inputSchema as Record<string, unknown>).additionalProperties).toBe(false);
      const payloadProps = Object.keys((e.payloadSchema as { properties: Record<string, unknown> }).properties);
      for (const forbidden of ["summary", "title", "revisionNote", "resolvedBy", "statusToken", "metadata"]) expect(payloadProps).not.toContain(forbidden);
    }
  });
});

describe("events/subscribe", () => {
  test("verifies the endpoint with a signed challenge, then grants a finite (capped) TTL", async () => {
    const secret = whsec();
    const r = await sub(await credFor("emp_sales"), {}, secret);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.result as Record<string, unknown>;
    expect(res.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(res.cursor).toBeNull();
    expect(res.truncated).toBe(false);
    // host not allowlisted + high-risk approvals included → elevated → 15 min default / 1 h cap
    expect(Date.parse(String(res.refreshBefore)) - clock).toBe(3_600_000);
    expect(posts).toHaveLength(1);
    const v = posts[0];
    expect(String(v.headers["webhook-id"])).toMatch(/^msg_verification_[A-Za-z0-9_-]{16,}$/);
    expect(v.headers["x-mcp-subscription-id"]).toBe(res.id);
    const parsed = parseWhsecSecret(secret);
    if (!parsed.ok) throw new Error("secret");
    expect(verifyStandardWebhook(parsed.key, { id: String(v.headers["webhook-id"]), timestamp: String(v.headers["webhook-timestamp"]), signature: String(v.headers["webhook-signature"]) }, v.body.toString("utf8"), { nowSec: Math.floor(clock / 1000) })).toBe(true);
    const audit = (await audits("mcp_events.subscribed")).find((e) => e.metadata.subscriptionId === res.id);
    expect(audit?.metadata).toMatchObject({ eventName: "approval.decided", risk: "elevated", receiverHost: "hooks.example.com" });
    expect(JSON.stringify(audit)).not.toContain(secret.slice(6, 20));
  });

  test("same key → same id (idempotent refresh), no second challenge, deliveryStatus; secret is stored encrypted only", async () => {
    const cred = await credFor("emp_sales");
    const first = await sub(cred);
    const secret2 = whsec();
    const again = await sub(cred, { ttlMs: 600_000 }, secret2);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect((again.result as { id: string }).id).toBe((first.result as { id: string }).id);
    expect(posts).toHaveLength(1);
    expect((again.result as { deliveryStatus?: unknown }).deliveryStatus).toEqual({ active: true, lastDeliveryAt: null, lastError: null });
    const row = await store.getEventSubscription((first.result as { id: string }).id);
    expect(row?.secretCiphertext.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(secret2.slice(6));
    expect(row?.previousSecretCiphertext).toBeTruthy();
    const ledger = await svc.listSubscriptionLedger(ORG);
    expect(ledger).toHaveLength(1);
    expect(Object.keys(ledger[0]).some((k) => /secret|fingerprint/i.test(k))).toBe(false);
  });

  test("invalid params / unknown event / unsupported mode / forbidden filter", async () => {
    const cred = await credFor("emp_sales");
    expect(await sub(cred, {}, "whsec_short")).toMatchObject({ ok: false, code: -32602 });
    expect(await sub(cred, { delivery: { mode: "webhook", url: "http://hooks.example.com/a", secret: whsec() } })).toMatchObject({ ok: false, code: -32602 });
    expect(await sub(cred, { arguments: { extra: 1 } })).toMatchObject({ ok: false, code: -32602 });
    expect(await sub(cred, { arguments: { risk: ["urgent"] } })).toMatchObject({ ok: false, code: -32602 });
    expect(await sub(cred, { name: "approval.whatever" })).toMatchObject({ ok: false, code: -32011, data: { kind: "event" } });
    expect(await sub(cred, { delivery: { mode: "push", url: "https://hooks.example.com/a", secret: whsec() } })).toMatchObject({ ok: false, code: -32014 });
    const other = await newApproval("emp_comm");
    expect(await sub(cred, { arguments: { approvalId: other.id } })).toMatchObject({ ok: false, code: -32012 });
    expect(await sub(cred, { arguments: { approvalId: "apr_does_not_exist" } })).toMatchObject({ ok: false, code: -32012 });
    expect(posts).toHaveLength(0);
  });

  test("failed verification → -32015 with a fixed category; nothing becomes active", async () => {
    const cred = await credFor("emp_sales");
    mode = "wrong";
    expect(await sub(cred)).toMatchObject({ ok: false, code: -32015, data: { reason: "challenge_failed" } });
    mode = 500;
    const r = await sub(cred);
    expect(r).toMatchObject({ ok: false, code: -32015, data: { reason: "http_5xx" } });
    expect(JSON.stringify(r)).not.toContain("internal detail");
    mode = "echo";
    dnsAnswer = [{ address: "169.254.169.254", family: 4 }];
    expect(await sub(cred)).toMatchObject({ ok: false, code: -32015, data: { reason: "connection_refused" } });
    expect(await svc.listSubscriptionLedger(ORG)).toHaveLength(0);
  });

  test("verification POSTs are rate-limited per receiver host → -32013", async () => {
    // per host across principals (each stays under its own 20-subscription cap)
    const creds = [await credFor("emp_sales"), await credFor("emp_comm"), await credFor("emp_sns")];
    for (let i = 0; i < 30; i++) {
      expect((await sub(creds[i % 3], { delivery: { mode: "webhook", url: `https://flood.example.org/v/${i}`, secret: whsec() } })).ok).toBe(true);
    }
    const cred = creds[0];
    expect(posts).toHaveLength(30);
    expect(await sub(cred, { delivery: { mode: "webhook", url: "https://flood.example.org/v/31", secret: whsec() } })).toMatchObject({ ok: false, code: -32013, data: { limit: "verification_rate" } });
    expect(posts).toHaveLength(30);
  });

  test("per-employee subscription cap → -32013", async () => {
    const cred = await credFor("emp_sales");
    for (let i = 0; i < 20; i++) {
      const r = await sub(cred, { delivery: { mode: "webhook", url: `https://hooks.example.com/mcp/${i}`, secret: whsec() } });
      expect(r.ok).toBe(true);
    }
    expect(await sub(cred, { delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/21", secret: whsec() } })).toMatchObject({ ok: false, code: -32013, data: { limit: "subscriptions", max: 20 } });
  });
});

describe("emit + delivery", () => {
  test("only the same org + employee receives it; body is ids + status only; signed; webhook-id = eventId", async () => {
    const secret = whsec();
    const mine = await sub(await credFor("emp_sales"), {}, secret);
    await sub(await credFor("emp_comm"), { delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/comm", secret: whsec() } });
    // A forged row for the same employee id in ANOTHER org must never match.
    const forged = await store.getEventSubscription((mine as { result: { id: string } }).result.id);
    await store.upsertEventSubscription({ ...forged!, id: "sub_" + "f".repeat(32), orgId: "org_other", deliveryUrl: "https://hooks.example.com/mcp/other", principal: "emp:org_other:emp_sales:g1" });
    posts.length = 0;
    const approval = await decide("emp_sales");
    const out = await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    expect(out.enqueued).toBe(1);
    expect(posts.map((p) => p.path)).toEqual(["/mcp/sales"]);
    const p = posts[0];
    const body = JSON.parse(p.body.toString("utf8"));
    expect(Object.keys(body).sort()).toEqual(["cursor", "data", "eventId", "name", "timestamp"]);
    expect(body).toMatchObject({ name: "approval.decided", cursor: null, eventId: out.eventId });
    expect(Object.keys(body.data).sort()).toEqual(["approvalId", "decidedAt", "employeeId", "fulfillment", "jobId", "risk", "status", "tool"]);
    expect(body.data).toMatchObject({ approvalId: approval.id, employeeId: "emp_sales", status: "approved", risk: "high", tool: "mail.send" });
    const raw = p.body.toString("utf8");
    for (const leak of ["TOP SECRET", "CONFIDENTIAL", "approver@example.com", approval.statusToken, "whsec_"]) expect(raw).not.toContain(leak);
    expect(p.headers["webhook-id"]).toBe(out.eventId);
    expect(p.headers["x-mcp-subscription-id"]).toBe((mine as { result: { id: string } }).result.id);
    expect(p.headers["content-type"]).toBe("application/json");
    const key = parseWhsecSecret(secret);
    if (!key.ok) throw new Error("secret");
    expect(verifyStandardWebhook(key.key, { id: String(p.headers["webhook-id"]), timestamp: String(p.headers["webhook-timestamp"]), signature: String(p.headers["webhook-signature"]) }, raw, { nowSec: Math.floor(clock / 1000) })).toBe(true);
    const delivered = (await audits("mcp_events.delivered")).find((e) => e.metadata.eventId === out.eventId);
    expect(delivered?.metadata).toMatchObject({ approvalId: approval.id, eventName: "approval.decided", attempt: 1 });
  });

  test("filters: status / risk / approvalId narrow what is delivered", async () => {
    const cred = await credFor("emp_sales");
    await sub(cred, { arguments: { status: ["rejected"] }, delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/rej", secret: whsec() } });
    await sub(cred, { arguments: { risk: ["low"] }, delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/low", secret: whsec() } });
    posts.length = 0;
    await svc.emitApprovalEvent({ approval: await decide("emp_sales", "approved", "high"), name: "approval.decided" }, { deliver: "inline" });
    expect(deliveriesTo("/mcp/rej")).toHaveLength(0);
    expect(deliveriesTo("/mcp/low")).toHaveLength(0);
    await svc.emitApprovalEvent({ approval: await decide("emp_sales", "rejected", "low"), name: "approval.decided" }, { deliver: "inline" });
    expect(deliveriesTo("/mcp/rej")).toHaveLength(1);
    expect(deliveriesTo("/mcp/low")).toHaveLength(1);
  });

  test("re-emitting the same decision is deduped (one delivery per subscription + event)", async () => {
    await sub(await credFor("emp_sales"));
    posts.length = 0;
    const approval = await decide("emp_sales");
    const a = await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    const b = await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    expect(b.eventId).toBe(a.eventId);
    expect(b.enqueued).toBe(0);
    expect(posts).toHaveLength(1);
  });

  test("retries keep the same webhook-id + body with a fresh timestamp; 2xx stops", async () => {
    await sub(await credFor("emp_sales"));
    posts.length = 0;
    deliveryStatusQueue = [503];
    const out = await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" });
    expect(posts).toHaveLength(1);
    expect(await svc.deliverDueEvents()).toMatchObject({ attempted: 0 }); // not due yet
    clock += 31_000;
    expect(await svc.deliverDueEvents()).toMatchObject({ attempted: 1, delivered: 1 });
    expect(posts).toHaveLength(2);
    expect(posts[1].headers["webhook-id"]).toBe(out.eventId);
    expect(posts[1].body.toString()).toBe(posts[0].body.toString());
    expect(posts[1].headers["webhook-timestamp"]).not.toBe(posts[0].headers["webhook-timestamp"]);
    clock += 3_600_000;
    expect(await svc.deliverDueEvents()).toMatchObject({ attempted: 0 });
  });

  test("410 is never retried; repeated failures are abandoned after 4 attempts", async () => {
    await sub(await credFor("emp_sales"));
    posts.length = 0;
    deliveryStatusQueue = [410];
    await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" });
    clock += 60_000;
    expect(await svc.deliverDueEvents()).toMatchObject({ attempted: 0 });
    expect(posts).toHaveLength(1);

    posts.length = 0;
    deliveryStatusQueue = [500, 500, 500, 500, 500];
    const out = await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" });
    // backoff 30 s → 2 min → 8 min (window 15 min); attempt 4 is the last
    for (let i = 0; i < 20; i++) { clock += 60_000; await svc.deliverDueEvents(); }
    expect(posts).toHaveLength(4);
    expect((await audits("mcp_events.delivery_abandoned")).some((e) => e.metadata.eventId === out.eventId && e.metadata.lastError === "http_5xx")).toBe(true);
    const refreshed = await sub(await credFor("emp_sales"));
    expect((refreshed as { result: { deliveryStatus: { lastError: string } } }).result.deliveryStatus.lastError).toBe("http_5xx");
  });

  test("an expired subscription (refreshBefore passed) gets nothing", async () => {
    await sub(await credFor("emp_sales"), { ttlMs: 300_000 });
    posts.length = 0;
    clock += 301_000;
    const out = await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" });
    expect(out.enqueued).toBe(0);
    expect(posts).toHaveLength(0);
  });

  test("unsubscribe is idempotent and stops delivery", async () => {
    const cred = await credFor("emp_sales");
    await sub(cred);
    const params = { name: "approval.decided", arguments: {}, delivery: { url: "https://hooks.example.com/mcp/sales" } };
    expect(await svc.handleEventsUnsubscribe(cred, params)).toEqual({ ok: true, result: {} });
    expect(await svc.handleEventsUnsubscribe(cred, params)).toEqual({ ok: true, result: {} });
    expect(await svc.handleEventsUnsubscribe(cred, { ...params, name: "approval.expired" })).toEqual({ ok: true, result: {} });
    posts.length = 0;
    await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" });
    expect(posts).toHaveLength(0);
  });

  test("approval.expired carries status + reason only", async () => {
    await sub(await credFor("emp_sales"), { name: "approval.expired" });
    posts.length = 0;
    const approval = { ...(await newApproval("emp_sales")), status: "expired" as const };
    const out = await svc.emitApprovalEvent({ approval, name: "approval.expired", reason: "ttl_elapsed" }, { deliver: "inline" });
    expect(out.enqueued).toBe(1);
    const body = JSON.parse(posts[0].body.toString());
    expect(Object.keys(body.data).sort()).toEqual(["approvalId", "employeeId", "expiredAt", "jobId", "reason", "risk", "status", "tool"]);
    expect(body.data).toMatchObject({ status: "expired", reason: "ttl_elapsed" });
  });
});

describe("revocation stops delivery immediately and refuses renewal", () => {
  test("binding revoked → no POST, subscription revoked (sticky), audit, refresh → -32012", async () => {
    const cred = await credFor("emp_comm");
    await sub(cred, { delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/comm", secret: whsec() } });
    posts.length = 0;
    const approval = await decide("emp_comm");
    await revokeBinding("emp_comm");
    const out = await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    expect(posts).toHaveLength(0);
    const ledger = await svc.listSubscriptionLedger(ORG);
    expect(ledger.find((r) => r.employeeId === "emp_comm")?.status).toBe("revoked");
    expect((await audits("mcp_events.subscription_revoked")).some((e) => e.employeeId === "emp_comm" && e.metadata.reason === "binding_revoked")).toBe(true);
    expect(out.eventId).toBeTruthy();
    expect(await sub(cred, { delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/comm", secret: whsec() } })).toMatchObject({ ok: false, code: -32012 });
  });

  test("badge rotated (new generation) → old subscription stops", async () => {
    const cred = await credFor("emp_sns");
    await sub(cred, { delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/sns", secret: whsec() } });
    posts.length = 0;
    const approval = await decide("emp_sns");
    await rotateCredential("emp_sns", ORG, fingerprintSecret("gb_emp_rotated_sns_test"));
    await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    expect(posts).toHaveLength(0);
    expect((await audits("mcp_events.subscription_revoked")).some((e) => e.employeeId === "emp_sns" && e.metadata.reason === "credential_rotated")).toBe(true);
  });
});

describe("audit: what woke the AI", () => {
  test("the first tools/call after a delivery is linked to that event (once)", async () => {
    const cred = await credFor("emp_sales");
    await sub(cred);
    const approval = await decide("emp_sales");
    const out = await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    clock += 20_000;
    await svc.recordTriggeredAction(cred, "staffpass_get_approval_status");
    await svc.recordTriggeredAction(cred, "staffpass_invoke");
    const rows = (await audits("mcp_events.triggered_action")).filter((e) => e.metadata.eventId === out.eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ approvalId: approval.id, eventName: "approval.decided", tool: "staffpass_get_approval_status", basis: "first_tool_call_after_delivery", lagMs: 20_000 });
  });
  test("no attribution outside the 30 min window", async () => {
    const cred = await credFor("emp_sales");
    await sub(cred);
    const out = await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" });
    clock += 31 * 60_000;
    await svc.recordTriggeredAction(cred, "staffpass_invoke");
    expect((await audits("mcp_events.triggered_action")).filter((e) => e.metadata.eventId === out.eventId)).toHaveLength(0);
  });
});

describe("flag OFF", () => {
  test("no emit, no delivery; events/* answer method-not-found", async () => {
    await sub(await credFor("emp_sales"));
    posts.length = 0;
    process.env.MCP_EVENTS_ENABLED = "false";
    try {
      const out = await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" });
      expect(out).toMatchObject({ enqueued: 0, skipped: "disabled" });
      expect(await svc.deliverDueEvents()).toMatchObject({ skipped: "disabled" });
      expect(await svc.handleEventsList(await credFor("emp_sales"))).toMatchObject({ ok: false, code: -32601 });
      expect(posts).toHaveLength(0);
    } finally {
      process.env.MCP_EVENTS_ENABLED = "true";
    }
  });
});
