/**
 * S3 (design §2.4 / §2.6, 木村 10/12): stop / release-request / release, demo mode.
 * Release is web-only behind ONE authentication function (fresh login ≤ 5 min today);
 * inbox approval of a release ticket is refused; a stop never fails silently.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holds3";

const { DEMO_ORG, getRuntimeMemberById } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const actions = await import("@/lib/safety/hold-actions");
const notify = await import("@/lib/safety/hold-notify");
const { verifyReleaseAuthentication } = await import("@/lib/safety/hold-release-auth");
const { writeDesignatedAdminMemberIds } = await import("@/lib/approver-authority/designated-admins");
const { getApprovalById, resolveApproval, listAuditEvents } = await import("@/lib/data");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
type HoldActor = import("@/lib/safety/hold-actions").HoldActor;
type HoldNotice = import("@/lib/safety/hold-notify").HoldNotice;

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const owner = () => getRuntimeMemberById("mem_1")!;
const admin = () => getRuntimeMemberById("mem_2")!;
const plain = () => getRuntimeMemberById("mem_3")!;
const fresh = () => new Date().toISOString();
const web = (m: ReturnType<typeof owner>, authTime: string | null = fresh()): HoldActor => ({ type: "member", member: m, surface: "web", authUserId: null, demoAuthTime: authTime ?? "invalid" });

let sent: Array<{ to: "tenant" | "ops"; n: HoldNotice }> = [];
let savedFlags: Record<string, string | undefined> = {};
beforeEach(async () => {
  savedFlags = { E: process.env.EMPLOYEE_HOLD_ENABLED, O: process.env.ORG_HOLD_ENABLED };
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  delete process.env.ORG_HOLD_ENABLED;
  sent = [];
  notify.__setHoldNotifierForTests({
    tenant: async (n) => { sent.push({ to: "tenant", n }); },
    ops: async (n) => { sent.push({ to: "ops", n }); },
  });
  store.__setHoldStoreForTests(null);
  store.__resetDemoHoldsForTests();
  actions.__setHoldSleepForTests(async () => undefined);
  hold.__setHoldReaderForTests(null);
  await writeDesignatedAdminMemberIds(ORG, ["mem_2"]); // two eligible approvers: owner + designated admin
});
afterEach(async () => {
  for (const [k, env] of [["E", "EMPLOYEE_HOLD_ENABLED"], ["O", "ORG_HOLD_ENABLED"]] as const) {
    if (savedFlags[k] === undefined) delete process.env[env]; else process.env[env] = savedFlags[k];
  }
  notify.__setHoldNotifierForTests(null);
  store.__setHoldStoreForTests(null);
  store.__resetDemoHoldsForTests();
  actions.__setHoldSleepForTests(null);
  await writeDesignatedAdminMemberIds(ORG, []);
});
const operable = () => hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });

describe("stop", () => {
  test("EMPLOYEE_HOLD_ENABLED unset → hold_disabled 404, nothing stopped (the is-stopped check itself stays flag-free)", async () => {
    delete process.env.EMPLOYEE_HOLD_ENABLED;
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    expect(r.ok ? "ok" : r.code).toBe("hold_disabled");
    expect((await operable()).ok).toBe(true);
  });
  test("owner stops from the web → held at once, audit row, tenant notice (ids only)", async () => {
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, reason: "顧客名入りの理由", actor: web(owner()) });
    expect(r.ok).toBe(true);
    const op = await operable();
    expect(op.ok ? "ok" : op.code).toBe("employee_on_hold");
    const audit = (await listAuditEvents(ORG)).find((e) => e.action === "employee.hold.started");
    expect(audit?.metadata?.startedBy).toBe("member:mem_1");
    expect(sent.some((s) => s.to === "tenant" && s.n.event === "hold.started")).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("顧客名");
  });
  test("a member without approve_actions / admin role cannot stop", async () => {
    const m = { ...plain(), capabilities: ["view_dashboard"] as never };
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(m) });
    expect(r.ok ? "ok" : r.code).toBe("forbidden");
  });
  test("org stop needs ORG_HOLD_ENABLED and the owner", async () => {
    expect((await actions.startHold({ orgId: ORG, employeeId: null, actor: web(owner()) }) as { code?: string }).code).toBe("org_hold_disabled");
    process.env.ORG_HOLD_ENABLED = "true";
    expect((await actions.startHold({ orgId: ORG, employeeId: null, actor: web(admin()) }) as { code?: string }).code).toBe("forbidden");
    expect((await actions.startHold({ orgId: ORG, employeeId: null, actor: web(owner()) })).ok).toBe(true);
    const r = await hold.checkOperable({ orgId: ORG, phase: "gateway" });
    expect(r.ok ? "ok" : r.code).toBe("org_on_hold");
  });
  test("re-stop with the same kind returns the existing hold (no second notice)", async () => {
    const a = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    const b = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(admin()) });
    expect(a.ok && b.ok && a.holdId === b.holdId && !b.created).toBe(true);
    expect(sent.filter((s) => s.n.event === "hold.started").length).toBe(1);
  });
  test("an ops-console stop upgrades a tenant stop", async () => {
    const a = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    const b = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: { type: "ops", opsId: "ops@staffpass.example", surface: "ops_console" } });
    expect(b.ok && b.upgraded && a.ok && b.holdId !== a.holdId).toBe(true);
  });
  test("non-human actor shapes are refused (ai_cannot_hold)", async () => {
    for (const actor of [{ type: "ai", employeeId: EMP }, { type: "member", member: owner(), surface: "mcp" }, { type: "ops", opsId: "x", surface: "web" }, null]) {
      const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: actor as never });
      expect(r.ok ? "ok" : r.code).toBe("ai_cannot_hold");
    }
  });
});

describe("stop never fails silently (40P01 / 40001 retry, then ops alert)", () => {
  const flaky = (codes: Array<string | null>) => {
    let i = 0;
    const real = store.__demoHoldStoreForTests();
    return { ...real, async start(input: Parameters<typeof real.start>[0]) {
      const c = codes[i++];
      if (c === "boom") throw new Error("boom");
      if (c) throw new store.HoldStoreError("hold_store_failed", c);
      return real.start(input);
    }, calls: () => i };
  };
  test("deadlock twice, then success → stopped after 3 attempts, no ops alert", async () => {
    const s = flaky(["40P01", "40001", null]);
    store.__setHoldStoreForTests(s);
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    expect(r.ok && r.attempts === 3).toBe(true);
    expect(sent.some((x) => x.n.event === "hold.start_failed")).toBe(false);
  });
  test("still 40001 after the retries → 503 hold_start_failed + ops alert (sqlstate, attempts) + audit", async () => {
    store.__setHoldStoreForTests(flaky(["40001", "40001", "40001", "40001", "40001", "40001"]));
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    expect(r.ok ? "ok" : `${r.code}:${r.httpStatus}`).toBe("hold_start_failed:503");
    const alert = sent.find((x) => x.to === "ops" && x.n.event === "hold.start_failed");
    expect(alert?.n.sqlState).toBe("40001");
    expect(alert?.n.attempts).toBe(5);
    expect((await listAuditEvents(ORG)).some((e) => e.action === "employee.hold.start_failed")).toBe(true);
  });
  test("木村 10/12 09:01: 4 serialization / lock failures in a row still stop on the 5th attempt", async () => {
    store.__setHoldStoreForTests(flaky(["40001", "40P01", "55P03", "40001", null]));
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    expect(r.ok && r.attempts === 5).toBe(true);
    expect(sent.some((x) => x.n.event === "hold.start_failed")).toBe(false);
  });
  test("backoff: exponential with jitter, within [base/2, base] of 50 / 100 / 200 / 400 ms", async () => {
    const waits: number[] = [];
    actions.__setHoldSleepForTests(async (ms) => { waits.push(ms); });
    for (let run = 0; run < 20; run++) {
      store.__setHoldStoreForTests(flaky(["40001", "40001", "40001", "40001", "40001"]));
      await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    }
    expect(waits.length).toBe(20 * 4);
    const bases = [50, 100, 200, 400];
    waits.forEach((ms, i) => {
      const base = bases[i % 4];
      expect(ms).toBeGreaterThanOrEqual(base / 2);
      expect(ms).toBeLessThanOrEqual(base);
    });
    // jitter: not all the same per step
    expect(new Set(waits.filter((_, i) => i % 4 === 3)).size).toBeGreaterThan(1);
    actions.__setHoldSleepForTests(async () => undefined);
  });
  test("an unexpected error is not retried but still alerts ops", async () => {
    const s = flaky(["boom"]);
    store.__setHoldStoreForTests(s);
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    expect(r.ok ? "ok" : r.code).toBe("hold_start_failed");
    expect(s.calls()).toBe(1);
    expect(sent.some((x) => x.to === "ops" && x.n.event === "hold.start_failed")).toBe(true);
  });
});

describe("release: web only, ONE authentication function, a different approver", () => {
  async function stopped() {
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    if (!r.ok) throw new Error(r.code);
    return r.holdId;
  }
  test("verifyReleaseAuthentication: web + this session's auth ≤ 5 min only", async () => {
    const now = new Date("2026-10-12T00:10:00Z");
    expect((await verifyReleaseAuthentication({ surface: "web", demoAuthTime: "2026-10-12T00:06:00Z" }, now)).ok).toBe(true);
    expect(await verifyReleaseAuthentication({ surface: "web", demoAuthTime: "2026-10-12T00:04:00Z" }, now)).toMatchObject({ ok: false, code: "fresh_login_required" });
    expect(await verifyReleaseAuthentication({ surface: "web", demoAuthTime: "invalid" }, now)).toMatchObject({ ok: false, code: "fresh_login_required" });
    for (const surface of ["slack", "line", "telegram", "ops_console", "mcp"]) {
      expect(await verifyReleaseAuthentication({ surface, demoAuthTime: "2026-10-12T00:09:00Z" }, now)).toMatchObject({ ok: false, code: "hold_release_web_only" });
    }
  });
  test("request: stale login → 401; inbox surface → 403; fresh web → ticket with metadata.requestedBy", async () => {
    const holdId = await stopped();
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: web(admin(), stale) })).toMatchObject({ ok: false, code: "fresh_login_required", httpStatus: 401 });
    expect(await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: { type: "member", member: admin(), surface: "slack" } })).toMatchObject({ ok: false, code: "hold_release_web_only" });
    const r = await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: web(admin()) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = await getApprovalById(r.approvalId, ORG);
    expect(t?.metadata?.requestedBy).toBe("member:mem_2");
    expect(t?.metadata?.holdId).toBe(holdId);
    expect(t?.metadata?.adminTool).toBe("employee.hold.release");
    expect(r.singleOwnerSelfRelease).toBe(false);
    // a text notice with a link, never an approval card
    expect(sent.some((s) => s.n.event === "hold.release_requested")).toBe(true);
  });
  test("reason is required", async () => {
    const holdId = await stopped();
    expect(await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "  ", actor: web(admin()) })).toMatchObject({ ok: false, code: "release_reason_required" });
  });
  test("the requester cannot approve (two people); another eligible approver releases; audit written", async () => {
    const holdId = await stopped();
    const req = await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: web(admin()) });
    expect(req.ok).toBe(true);
    expect(await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(admin()) })).toMatchObject({ ok: false, code: "self_approval_denied" });
    expect((await operable()).ok).toBe(false);
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(owner(), stale) })).toMatchObject({ ok: false, code: "fresh_login_required" });
    expect((await operable()).ok).toBe(false);
    const ok = await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(owner()) });
    expect(ok.ok).toBe(true);
    expect((await operable()).ok).toBe(true);
    const audit = (await listAuditEvents(ORG)).find((e) => e.action === "employee.hold.released");
    expect(audit?.metadata?.releasedBy).toBe("member:mem_1");
    expect(audit?.metadata?.requestedBy).toBe("member:mem_2");
  });
  test("double-click: the losing release (hold already released) does NOT reset the ticket to pending", async () => {
    const holdId = await stopped();
    const req = await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: web(admin()) });
    if (!req.ok) throw new Error(req.code);
    const real = store.getHoldStore();
    const snapshot = await real.getHold(ORG, holdId);
    expect((await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(owner()) })).ok).toBe(true);
    // second click: it read the hold before the first committed, then its release loses
    let reads = 0;
    store.__setHoldStoreForTests({ ...real, getHold: async (o, id) => (reads++ === 0 ? snapshot : real.getHold(o, id)) });
    try {
      const second = await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(owner()) });
      expect(second.ok).toBe(false);
    } finally {
      store.__setHoldStoreForTests(null);
    }
    expect((await getApprovalById(req.approvalId, ORG))?.status).toBe("approved");
    expect((await operable()).ok).toBe(true);
  });
  test("a failed release of a hold that is still open DOES put the ticket back to pending (retryable)", async () => {
    const holdId = await stopped();
    const req = await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: web(admin()) });
    if (!req.ok) throw new Error(req.code);
    const real = store.getHoldStore();
    store.__setHoldStoreForTests({ ...real, release: async () => { throw new store.HoldStoreError("hold_store_failed"); } });
    try {
      expect((await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(owner()) })).ok).toBe(false);
    } finally {
      store.__setHoldStoreForTests(null);
    }
    expect((await getApprovalById(req.approvalId, ORG))?.status).toBe("pending");
    expect((await operable()).ok).toBe(false);
  });
  test("a plain member who is neither owner nor designated admin cannot approve", async () => {
    const holdId = await stopped();
    await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: web(admin()) });
    expect(await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(plain()) })).toMatchObject({ ok: false, code: "release_approver_not_allowed" });
  });
  test("inbox / generic approval of a release ticket is refused (web-only), the ticket stays pending", async () => {
    const holdId = await stopped();
    const req = await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: web(admin()) });
    if (!req.ok) throw new Error(req.code);
    const viaWorkflow = await resolveApprovalWithWorkflow(req.approvalId, "approved", "slack:U1", ORG, { memberId: "mem_1" });
    expect(viaWorkflow.ok).toBe(false);
    expect(viaWorkflow.reason).toBe("hold_release_web_only");
    expect(await resolveApproval(req.approvalId, "approved", "owner@example.com", ORG, { memberId: "mem_1" })).toBeNull();
    expect((await getApprovalById(req.approvalId, ORG))?.status).toBe("pending");
    expect((await operable()).ok).toBe(false);
  });
  test("single-owner org: the owner may self-release a tenant stop (reason recorded)", async () => {
    await writeDesignatedAdminMemberIds(ORG, []);
    const holdId = await stopped();
    const req = await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "確認済み", actor: web(owner()) });
    expect(req.ok && req.singleOwnerSelfRelease).toBe(true);
    expect((await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(owner()) })).ok).toBe(true);
  });
  test("an ops-console hold can't be released by the tenant (S4)", async () => {
    const r = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: { type: "ops", opsId: "ops@staffpass.example", surface: "ops_console" } });
    if (!r.ok) throw new Error(r.code);
    expect(await actions.requestHoldRelease({ orgId: ORG, holdId: r.holdId, reason: "x", actor: web(owner()) })).toMatchObject({ ok: false, code: "ops_hold_ops_only" });
  });
  test("if the release audit cannot be written, the stop is NOT lifted and the ticket goes back to pending", async () => {
    const holdId = await stopped();
    const req = await actions.requestHoldRelease({ orgId: ORG, holdId, reason: "誤停止", actor: web(admin()) });
    if (!req.ok) throw new Error(req.code);
    const real = store.__demoHoldStoreForTests();
    store.__setHoldStoreForTests({ ...real, release: async () => { throw new store.HoldStoreError("hold_store_failed", "XX000"); } });
    const r = await actions.approveHoldRelease({ orgId: ORG, holdId, actor: web(owner()) });
    expect(r.ok ? "ok" : `${r.code}:${r.httpStatus}`).toBe("hold_store_failed:503");
    expect((await operable()).ok).toBe(false);
    expect((await getApprovalById(req.approvalId, ORG))?.status).toBe("pending");
  });
});
