/**
 * Fail-first: a retired employee (employees.status = suspended) is refused by
 * checkOperable. Distinct from emergency hold / PR-K leave.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { DEMO_ORG, getRuntimeEmployees } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
let originalStatus: string;

beforeEach(() => {
  hold.__setHoldReaderForTests(null);
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  const emp = getRuntimeEmployees().find((item) => item.id === EMP);
  originalStatus = emp?.status ?? "active";
  if (emp) emp.status = "active";
});
afterEach(() => {
  hold.__setHoldReaderForTests(null);
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  const emp = getRuntimeEmployees().find((item) => item.id === EMP);
  if (emp) emp.status = originalStatus as typeof emp.status;
});

describe("checkOperable refuses a retired (suspended) employee", () => {
  test("status=suspended → employee_terminated (not employee_on_hold)", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === EMP)!;
    emp.status = "suspended";
    const r = await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });
    expect(r).toEqual({ ok: false, code: "employee_terminated", holdId: null, kind: null });
  });

  test("every checkpoint refuses a retired employee", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === EMP)!;
    emp.status = "suspended";
    for (const phase of ["credential", "oauth", "gateway", "approval_execution", "wake", "mcp_events", "pre_send"] as const) {
      const r = await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase });
      expect({ phase, ok: r.ok, code: r.ok ? "ok" : r.code }).toEqual({
        phase,
        ok: false,
        code: "employee_terminated",
      });
    }
  });

  test("draft is not retirement; active + no hold stays operable", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === EMP)!;
    emp.status = "draft";
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "wake" })).ok).toBe(true);
    emp.status = "active";
    expect(await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "wake" })).toEqual({ ok: true });
  });

  test("HOLD_STOP_CODES includes employee_terminated", () => {
    expect(hold.HOLD_STOP_CODES.has("employee_terminated")).toBe(true);
  });
});
