/**
 * 木村 10/12 (LOW): comm.delete also gets the just-before-send hold check — a hold that
 * lands after the fulfil gate passed still stops the provider call. Record lookups and
 * the Slack deleter are stubbed; only the hold decides.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let deletes = 0;
const realRecord = { ...(await import("@/lib/comm-delete/post-record")) };
mock.module("@/lib/comm-delete/post-record", () => ({
  ...realRecord,
  findOwnPostRecord: async () => ({ ok: true, found: { postedVia: "bot", source: "post_record", auditId: "aud_1", postedAt: new Date().toISOString() } }),
  findOwnDeleteDone: async () => ({ ok: true, found: null }),
}));
mock.module("@/lib/comm-delete/slack", () => ({
  deleteSlackPost: async () => { deletes++; return { ok: true, deletedVia: "bot", delivery: "bot" }; },
}));

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const { executeCommDelete } = await import("@/lib/comm-delete/run");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const HID = "00000000-0000-4000-8000-0000000000d1";
beforeEach(() => { deletes = 0; hold.demoSetEmployeeHold(EMP, null); hold.demoSetOrgHold(ORG, null); hold.__setHoldReaderForTests(null); });
afterEach(() => { hold.demoSetEmployeeHold(EMP, null); hold.demoSetOrgHold(ORG, null); hold.__setHoldReaderForTests(null); });

const ctx = { orgId: ORG, employeeId: EMP, credentialId: null, purpose: "comm.cleanup", jobId: "job_cd", approvalId: "apr_cd", phase: "approval.fulfill" as const };
const target = { surface: "slack" as const, channel: "C123", messageId: "1700000000.000100" };

for (const [name, set, code] of [
  ["employee on hold", () => hold.demoSetEmployeeHold(EMP, { kind: "stopped", holdId: HID }), "employee_on_hold"],
  ["org on hold", () => hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HID }), "org_on_hold"],
  ["hold state unreadable", () => hold.__setHoldReaderForTests({ employee: async () => { throw new Error("db"); }, org: async () => { throw new Error("db"); } }), "hold_state_unavailable"],
] as const) {
  test(`comm.delete just before the Slack call, ${name} → ${code}, deleter never called`, async () => {
    set();
    const o = await executeCommDelete(ctx, target);
    expect(o.ok).toBe(false);
    expect(o.code).toBe(code);
    expect(deletes).toBe(0);
  });
}
test("control: no hold → the delete goes out once", async () => {
  const o = await executeCommDelete(ctx, target);
  expect(o.ok).toBe(true);
  expect(deletes).toBe(1);
});
