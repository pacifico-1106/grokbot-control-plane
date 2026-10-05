/**
 * MCP Events delivery resilience (木村 review of #267, 2026-10-05):
 * 1. A transient DB / read error during the revocation re-check must NOT revoke
 *    subscriptions or drop pending deliveries: the attempt is deferred (not
 *    counted), audited/logged as revocation_check_unavailable, and retried.
 *    Only positively-known revocation (row confirmed missing / revoked,
 *    generation or fingerprint mismatch, employee suspended) revokes.
 * 3b. A non-public address found at delivery time is permanent (abandoned, no retry).
 * 3c. Every claimed attempt is counted (a crash after claim cannot retry forever).
 * 3d. Finished delivery rows are deleted after the documented retention.
 * Demo mode, dummy values, fake receiver (no network).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-mcpevents";
process.env.MCP_EVENTS_ENABLED = "true";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { getBinding, listAuditEvents } = await import("@/lib/data");
const { createApproval, resolveApproval } = await import("@/lib/data/approvals");
const svc = await import("@/lib/mcp-events/service");
const store = await import("@/lib/mcp-events/store");
const principal = await import("@/lib/mcp-events/principal");
const { MCP_EVENTS_LIMITS } = await import("@/lib/mcp-events/policy");
type Cred = import("@/lib/auth/employee-credential").ResolvedEmployeeCredential;
type PinnedRequest = import("@/lib/mcp-events/transport").PinnedRequest;
type Reader = import("@/lib/mcp-events/principal").PrincipalReader;

const ORG = DEMO_ORG.id;
let clock = Date.parse("2026-10-05T03:00:00Z");
const posts: PinnedRequest[] = [];
let dnsAnswer: Array<{ address: string; family: 4 | 6 }> = [{ address: "93.184.216.34", family: 4 }];
let dnsAtDelivery: Array<{ address: string; family: 4 | 6 }> | null = null;

function receiver() {
  return {
    lookup: async () => dnsAnswer,
    request: async (req: PinnedRequest) => {
      posts.push(req);
      const body = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
      if (body.type === "verification") return { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
      return { status: 200, body: Buffer.from("") };
    },
  };
}
async function credFor(employeeId: string, credentialId: string | null = null): Promise<Cred> {
  const b = await getBinding(employeeId);
  if (!b) throw new Error("no binding");
  return { employeeId, orgId: b.orgId, generation: b.credentialGeneration, credentialId, fingerprint: b.credentialFingerprint!, binding: b, secretPrefix: "gb_emp_" };
}
const whsec = () => `whsec_${randomBytes(32).toString("base64")}`;
const sub = (cred: Cred, over: Record<string, unknown> = {}) => svc.handleEventsSubscribe(cred, {
  name: "approval.decided", arguments: {}, delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/sales", secret: whsec() }, cursor: null, ttlMs: 3_600_000, ...over,
});
const eventPosts = () => posts.filter((p) => !String(p.headers["webhook-id"]).startsWith("msg_verification_"));
async function decide(employeeId: string) {
  const { approval } = await createApproval({
    orgId: ORG, employeeId, credentialId: "cred_test", title: "T", purpose: "mail.send", summary: "S", risk: "high", tool: "mail.send",
    jobId: `job_${Math.random().toString(36).slice(2, 8)}`,
  });
  const resolved = await resolveApproval(approval.id, "approved", "web:approver@example.com", ORG, {});
  if (!resolved) throw new Error("not resolved");
  return resolved;
}
const audits = async (action: string) => (await listAuditEvents(ORG, 2000)).filter((e) => e.action === action);
const ledgerStatus = async (employeeId: string) => (await svc.listSubscriptionLedger(ORG)).filter((r) => r.employeeId === employeeId).map((r) => r.status);

/** The real reader for this mode, with one method forced to a read error / throw. */
function failing(which: keyof Reader, how: "error" | "throw" = "error"): Reader {
  const base = principal.defaultPrincipalReader();
  const fail = async () => {
    if (how === "throw") throw new Error("connection reset by peer");
    return { state: "error" as const, detail: "db_timeout" };
  };
  return { ...base, [which]: fail } as Reader;
}

beforeEach(() => {
  store.__resetMcpEventsStoreForTests();
  svc.__setMcpEventsTransportForTests({
    lookup: async () => dnsAtDelivery ?? dnsAnswer,
    request: receiver().request,
  });
  svc.__setMcpEventsClockForTests(() => clock);
  principal.__setPrincipalReaderForTests(null);
  posts.length = 0;
  dnsAnswer = [{ address: "93.184.216.34", family: 4 }];
  dnsAtDelivery = null;
});
afterEach(() => {
  svc.__setMcpEventsTransportForTests(null);
  svc.__setMcpEventsClockForTests(null);
  principal.__setPrincipalReaderForTests(null);
});

describe("1. transient revocation-check failures defer, never revoke", () => {
  for (const [which, how] of [["binding", "error"], ["employee", "error"], ["credential", "error"], ["binding", "throw"]] as const) {
    test(`${which} read ${how} → deferred: no POST, no revoke, nothing dropped, attempt not counted; retried later`, async () => {
      const cred = await credFor("emp_sales", which === "credential" ? "cred_live_1" : null);
      expect((await sub(cred)).ok).toBe(true);
      posts.length = 0;
      const approval = await decide("emp_sales");
      principal.__setPrincipalReaderForTests(failing(which, how));
      await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
      expect(eventPosts()).toHaveLength(0);
      expect(await ledgerStatus("emp_sales")).toEqual(["active"]);
      expect(await audits("mcp_events.subscription_revoked")).toHaveLength(0);
      const rows = store.__listDeliveriesForTests();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "pending", attempts: 0, lastError: "revocation_check_unavailable" });
      expect(Date.parse(rows[0].nextAttemptAt!)).toBe(clock + MCP_EVENTS_LIMITS.deferMs);
      const deferred = await audits("mcp_events.delivery_deferred");
      expect(deferred.some((e) => e.metadata.reason === "revocation_check_unavailable" && e.metadata.eventId === rows[0].eventId)).toBe(true);

      // still failing on the next cron run: still deferred, still not counted
      clock += MCP_EVENTS_LIMITS.deferMs;
      expect(await svc.deliverDueEvents()).toMatchObject({ attempted: 0, deferred: 1, dropped: 0 });
      expect(store.__listDeliveriesForTests()[0]).toMatchObject({ status: "pending", attempts: 0 });

      // recovered → delivered as attempt 1
      principal.__setPrincipalReaderForTests(null);
      clock += MCP_EVENTS_LIMITS.deferMs;
      expect(await svc.deliverDueEvents()).toMatchObject({ attempted: 1, delivered: 1 });
      expect(eventPosts()).toHaveLength(1);
      expect((await audits("mcp_events.delivered")).find((e) => e.metadata.approvalId === approval.id)?.metadata.attempt).toBe(1);
    });
  }

  test("unavailable past the retry window → abandoned (revocation_check_unavailable), subscription stays active", async () => {
    await sub(await credFor("emp_sales"));
    posts.length = 0;
    const approval = await decide("emp_sales");
    principal.__setPrincipalReaderForTests(failing("binding"));
    await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    for (let i = 0; i < 20; i++) { clock += MCP_EVENTS_LIMITS.deferMs; await svc.deliverDueEvents(); }
    expect(eventPosts()).toHaveLength(0);
    expect(store.__listDeliveriesForTests()[0]).toMatchObject({ status: "abandoned", lastError: "revocation_check_unavailable", attempts: 0 });
    expect((await audits("mcp_events.delivery_abandoned")).some((e) => e.metadata.approvalId === approval.id && e.metadata.reason === "revocation_check_unavailable")).toBe(true);
    expect(await ledgerStatus("emp_sales")).toEqual(["active"]);
    expect(await audits("mcp_events.subscription_revoked")).toHaveLength(0);
  });

  test("a pending delivery of ANOTHER subscription is not dropped by a failed check", async () => {
    const cred = await credFor("emp_sales");
    await sub(cred);
    await sub(cred, { delivery: { mode: "webhook", url: "https://hooks.example.com/mcp/second", secret: whsec() } });
    posts.length = 0;
    const approval = await decide("emp_sales");
    principal.__setPrincipalReaderForTests(failing("employee"));
    await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    const rows = store.__listDeliveriesForTests();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  test("subscribe while the check is unavailable → -32603 revocation_check_unavailable (retryable), not -32012; then works", async () => {
    const cred = await credFor("emp_sales");
    principal.__setPrincipalReaderForTests(failing("binding"));
    expect(await sub(cred)).toMatchObject({ ok: false, code: -32603, data: { reason: "revocation_check_unavailable" } });
    principal.__setPrincipalReaderForTests(null);
    expect((await sub(cred)).ok).toBe(true);
  });

  test("positively known revocation still revokes: binding row missing / employee suspended / credential revoked", async () => {
    const cases: Array<[string, Partial<Reader>, string, string | null]> = [
      ["emp_sales", { binding: async () => ({ state: "missing" as const }) }, "binding_missing", null],
      ["emp_comm", { employee: async () => ({ state: "found" as const, value: { orgId: ORG, status: "suspended" } }) }, "employee_suspended", null],
      ["emp_sns", { credential: async () => ({ state: "found" as const, value: { revokedAt: "2026-10-01T00:00:00Z", expiresAt: null } }) }, "credential_revoked", "cred_live_2"],
    ];
    for (const [emp, override, reason, credentialId] of cases) {
      principal.__setPrincipalReaderForTests(null);
      await sub(await credFor(emp, credentialId), { delivery: { mode: "webhook", url: `https://hooks.example.com/mcp/${emp}`, secret: whsec() } });
      const approval = await decide(emp);
      principal.__setPrincipalReaderForTests({ ...principal.defaultPrincipalReader(), ...override });
      posts.length = 0;
      await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
      expect(eventPosts()).toHaveLength(0);
      expect(await ledgerStatus(emp)).toEqual(["revoked"]);
      expect((await audits("mcp_events.subscription_revoked")).some((e) => e.employeeId === emp && e.metadata.reason === reason)).toBe(true);
    }
  });
});

describe("1. checkSubscriptionPrincipal kinds (production reader: principal-reader.test.ts)", () => {
  test("checkSubscriptionPrincipal: error → unavailable (kind), missing → revoked", async () => {
    const subRow = { orgId: ORG, employeeId: "emp_sales", credentialGeneration: 1, credentialFingerprint: "fp", credentialId: null };
    principal.__setPrincipalReaderForTests(failing("binding"));
    expect(await principal.checkSubscriptionPrincipal(subRow, clock)).toMatchObject({ ok: false, kind: "unavailable", reason: "revocation_check_unavailable" });
    principal.__setPrincipalReaderForTests({ ...principal.defaultPrincipalReader(), binding: async () => ({ state: "missing" }) });
    expect(await principal.checkSubscriptionPrincipal(subRow, clock)).toMatchObject({ ok: false, kind: "revoked", reason: "binding_missing" });
  });
});

describe("3b. non-public address at delivery time is permanent", () => {
  test("private answer at delivery → abandoned once (address_blocked), never retried", async () => {
    await sub(await credFor("emp_sales"));
    dnsAtDelivery = [{ address: "10.0.0.8", family: 4 }];
    const approval = await decide("emp_sales");
    await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "inline" });
    expect(eventPosts()).toHaveLength(0);
    expect(store.__listDeliveriesForTests()[0]).toMatchObject({ status: "abandoned", attempts: 1, lastError: "address_blocked" });
    dnsAtDelivery = null;
    for (let i = 0; i < 5; i++) { clock += 5 * 60_000; await svc.deliverDueEvents(); }
    expect(eventPosts()).toHaveLength(0);
    expect((await audits("mcp_events.delivery_abandoned")).some((e) => e.metadata.approvalId === approval.id && e.metadata.reason === "address_blocked")).toBe(true);
  });
});

describe("3c. every claimed attempt is counted", () => {
  test("a worker that dies after claiming still used up that attempt", async () => {
    await sub(await credFor("emp_sales"));
    const approval = await decide("emp_sales");
    await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "none" });
    const [id] = await store.listDueDeliveryIds(new Date(clock).toISOString(), 10);
    const claimed = await store.claimDelivery(id, new Date(clock).toISOString(), new Date(clock + 60_000).toISOString());
    expect(claimed?.attempts).toBe(1);
    // lease expires, the cron picks it up: this is attempt 2
    clock += 61_000;
    expect(await svc.deliverDueEvents()).toMatchObject({ attempted: 1, delivered: 1 });
    expect(store.__listDeliveriesForTests()[0]).toMatchObject({ status: "delivered", attempts: 2 });
    expect((await audits("mcp_events.delivered")).find((e) => e.metadata.approvalId === approval.id)?.metadata.attempt).toBe(2);
  });
  test("repeated crashes after claim end in abandoned (max_attempts_exceeded), no 5th POST", async () => {
    await sub(await credFor("emp_sales"));
    posts.length = 0;
    const approval = await decide("emp_sales");
    await svc.emitApprovalEvent({ approval, name: "approval.decided" }, { deliver: "none" });
    const [id] = await store.listDueDeliveryIds(new Date(clock).toISOString(), 10);
    for (let i = 0; i < MCP_EVENTS_LIMITS.maxAttempts; i++) {
      expect(await store.claimDelivery(id, new Date(clock).toISOString(), new Date(clock + 60_000).toISOString())).toBeTruthy();
      clock += 61_000;
    }
    expect(await svc.deliverDueEvents()).toMatchObject({ attempted: 1, abandoned: 1 });
    expect(eventPosts()).toHaveLength(0);
    expect(store.__listDeliveriesForTests()[0]).toMatchObject({ status: "abandoned", lastError: "max_attempts_exceeded" });
  });
  test("a concurrent second claim of the same attempt fails (claim is compare-and-set)", async () => {
    await sub(await credFor("emp_sales"));
    await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "none" });
    const [id] = await store.listDueDeliveryIds(new Date(clock).toISOString(), 10);
    const now = new Date(clock).toISOString();
    const lease = new Date(clock + 60_000).toISOString();
    const [a, b] = await Promise.all([store.claimDelivery(id, now, lease), store.claimDelivery(id, now, lease)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("3d. retention of finished delivery rows", () => {
  test(`delivered / abandoned / dropped rows older than ${MCP_EVENTS_LIMITS.deliveryRetentionMs / 86_400_000} days are deleted; pending and recent rows stay`, async () => {
    expect(MCP_EVENTS_LIMITS.deliveryRetentionMs).toBe(7 * 24 * 60 * 60_000);
    const cred = await credFor("emp_sales");
    await sub(cred, { ttlMs: 24 * 3_600_000 });
    await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" }); // delivered (old)
    const rows0 = store.__listDeliveriesForTests();
    expect(rows0[0].status).toBe("delivered");
    clock += MCP_EVENTS_LIMITS.deliveryRetentionMs + 60_000;
    await sub(cred, { ttlMs: 24 * 3_600_000 });
    principal.__setPrincipalReaderForTests(failing("binding"));
    await svc.emitApprovalEvent({ approval: await decide("emp_sales"), name: "approval.decided" }, { deliver: "inline" }); // pending (deferred), new
    principal.__setPrincipalReaderForTests(null);
    const out = await svc.pruneFinishedDeliveries();
    expect(out.deleted).toBe(1);
    const left = store.__listDeliveriesForTests();
    expect(left.map((r) => r.status)).toEqual(["pending"]);
  });
});

describe("3e. D11 verification-window cleanup", () => {
  test("pruneVerificationWindows drops windows that started more than verificationWindowRetentionMs ago; the current window stays", async () => {
    expect(MCP_EVENTS_LIMITS.verificationWindowRetentionMs).toBe(10 * 60_000);
    const cred = await credFor("emp_sales");
    await sub(cred, { ttlMs: 24 * 3_600_000 }); // one challenge → one window row for the host
    expect((await svc.pruneVerificationWindows()).deleted).toBe(0);
    clock += MCP_EVENTS_LIMITS.verificationWindowRetentionMs + 60_000;
    await sub(cred, { delivery: { mode: "webhook", url: "https://other.example.net/mcp", secret: whsec() } }); // a fresh window
    expect((await svc.pruneVerificationWindows()).deleted).toBe(1);
    expect((await svc.pruneVerificationWindows()).deleted).toBe(0);
  });
  test("flag off → no-op", async () => {
    const before = process.env.MCP_EVENTS_ENABLED;
    process.env.MCP_EVENTS_ENABLED = "false";
    try { expect(await svc.pruneVerificationWindows()).toEqual({ deleted: 0 }); } finally { process.env.MCP_EVENTS_ENABLED = before; }
  });
});
