/**
 * Fail-first: a hung self-approval audit write must not delay the 403.
 * MCP hold 403 already fire-and-forgets (void auditMcpAuthFailure); this
 * path must do the same — void recordSelfApprovalDenied, never await it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holdhang";

let hangAudit = false;
mock.module("@/lib/safety/hold-denial-audit", () => ({
  recordSelfApprovalDenied: async () => {
    if (hangAudit) return new Promise(() => {});
  },
  recordMcpHoldDenied: async () => undefined,
  isHoldDenialAuditEnabled: () => true,
}));

const { DEMO_ORG, getRuntimeMemberById } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const actions = await import("@/lib/safety/hold-actions");
const notify = await import("@/lib/safety/hold-notify");
const { writeDesignatedAdminMemberIds } = await import("@/lib/approver-authority/designated-admins");
type HoldActor = import("@/lib/safety/hold-actions").HoldActor;

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const owner = () => getRuntimeMemberById("mem_1")!;
const admin = () => getRuntimeMemberById("mem_2")!;
const fresh = () => new Date().toISOString();
const web = (m: ReturnType<typeof owner>, authTime: string | null = fresh()): HoldActor => ({
  type: "member",
  member: m,
  surface: "web",
  authUserId: null,
  demoAuthTime: authTime ?? "invalid",
});

let savedFlags: Record<string, string | undefined> = {};
beforeEach(async () => {
  hangAudit = false;
  savedFlags = {
    E: process.env.EMPLOYEE_HOLD_ENABLED,
    A: process.env.HOLD_DENIAL_AUDIT_ENABLED,
  };
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  process.env.HOLD_DENIAL_AUDIT_ENABLED = "1";
  notify.__setHoldNotifierForTests({
    tenant: async () => undefined,
    ops: async () => undefined,
  });
  store.__setHoldStoreForTests(null);
  store.__resetDemoHoldsForTests();
  actions.__setHoldSleepForTests(async () => undefined);
  hold.__setHoldReaderForTests(null);
  await writeDesignatedAdminMemberIds(ORG, ["mem_2"]);
});
afterEach(async () => {
  hangAudit = false;
  for (const [k, env] of [
    ["E", "EMPLOYEE_HOLD_ENABLED"],
    ["A", "HOLD_DENIAL_AUDIT_ENABLED"],
  ] as const) {
    if (savedFlags[k] === undefined) delete process.env[env];
    else process.env[env] = savedFlags[k];
  }
  notify.__setHoldNotifierForTests(null);
  store.__setHoldStoreForTests(null);
  store.__resetDemoHoldsForTests();
  actions.__setHoldSleepForTests(null);
  await writeDesignatedAdminMemberIds(ORG, []);
});

describe("self_approval_denied 403 is not gated on the audit write", () => {
  test("hung recordSelfApprovalDenied still returns 403 immediately", async () => {
    const startedHold = await actions.startHold({ orgId: ORG, employeeId: EMP, actor: web(owner()) });
    if (!startedHold.ok) throw new Error(startedHold.code);
    const req = await actions.requestHoldRelease({
      orgId: ORG,
      holdId: startedHold.holdId,
      reason: "誤停止",
      actor: web(admin()),
    });
    expect(req.ok).toBe(true);
    hangAudit = true;
    const started = Date.now();
    const denied = await Promise.race([
      actions.approveHoldRelease({ orgId: ORG, holdId: startedHold.holdId, actor: web(admin()) }),
      new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 800)),
    ]);
    expect(denied).toMatchObject({
      ok: false,
      code: "self_approval_denied",
      httpStatus: 403,
    });
    expect(Date.now() - started).toBeLessThan(800);
  }, 2000);
});
