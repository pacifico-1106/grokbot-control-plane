/**
 * 木村 10/12: comm.delete (post-incident cleanup) stays BLOCKED while the employee
 * or org is held — same as every other employee action. Locked in here: neither
 * the approved-ticket path (fulfil) nor the gateway entry reaches the deleter.
 * Demo mode; the deleter and the policy re-check are stubbed so only the hold
 * decides the outcome.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let deletes = 0;
mock.module("@/lib/comm-delete/fulfill", () => ({
  fulfillCommDeleteApproval: async () => { deletes++; return { ok: true, at: new Date().toISOString() }; },
}));
const realRecheck = { ...(await import("@/lib/approvals/fulfill-policy-recheck")) };
mock.module("@/lib/approvals/fulfill-policy-recheck", () => ({
  ...realRecheck,
  recheckPolicyAtFulfill: async () => ({ ok: true }),
}));

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const { fulfillApprovedInvoke } = await import("@/lib/approvals/fulfill");
const { assertExecutable } = await import("@/lib/data/bindings");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const HID = "00000000-0000-4000-8000-0000000000c1";
beforeEach(() => { deletes = 0; hold.demoSetEmployeeHold(EMP, null); hold.demoSetOrgHold(ORG, null); hold.__setHoldReaderForTests(null); });
afterEach(() => { hold.demoSetEmployeeHold(EMP, null); hold.demoSetOrgHold(ORG, null); hold.__setHoldReaderForTests(null); });

const ticket = () => ({
  id: `apr_cd_${Math.random().toString(36).slice(2)}`, orgId: ORG, employeeId: EMP, credentialId: "cred_sales",
  title: "t", purpose: "comm.cleanup", summary: "s", risk: "low", status: "approved", tool: "comm.delete",
  createdAt: new Date().toISOString(), resolvedAt: new Date(Date.now() - 60_000).toISOString(), resolvedBy: "mem_1",
  metadata: { invoke: { tool: "comm.delete", args: { channel: "C1", ts: "1.1" } } },
}) as never;

for (const [name, set, code] of [
  ["employee on hold", () => hold.demoSetEmployeeHold(EMP, { kind: "stopped", holdId: HID }), "employee_on_hold"],
  ["org on hold", () => hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HID }), "org_on_hold"],
] as const) {
  test(`approved comm.delete, ${name} → not executed (${code}), deleter never called`, async () => {
    set();
    const r = await fulfillApprovedInvoke(ticket());
    expect(r?.ok).toBe(false);
    expect(String(r && "error" in r ? r.error : "")).toContain(code);
    expect(deletes).toBe(0);
  });
  test(`gateway entry for comm.delete, ${name} → refused (${code})`, async () => {
    set();
    const g = await assertExecutable(EMP);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe(code);
  });
}

test("control: no hold → the approved comm.delete runs once", async () => {
  const r = await fulfillApprovedInvoke(ticket());
  expect(deletes).toBe(1);
  expect(r?.ok).toBe(true);
});
