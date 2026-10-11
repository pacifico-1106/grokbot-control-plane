/** 木村 10/12 (LOW): bounded throttles, throttled wake_suppressed rows, per-request hold reuse. */
import { beforeEach, expect, test } from "bun:test";

const hold = await import("@/lib/safety/hold");
const ORG = "11111111-1111-4111-8111-111111111111";
const EMP = "22222222-2222-4222-8222-222222222222";
const HID = "33333333-3333-4333-8333-333333333333";

let empReads = 0;
let orgReads = 0;
let empState: "none" | "held" | "error" = "none";
beforeEach(() => {
  empReads = 0; orgReads = 0; empState = "none";
  hold.__resetHoldAuditThrottleForTests();
  hold.__setHoldReaderForTests({
    employee: async () => {
      empReads++;
      if (empState === "error") return { state: "error", detail: "boom" };
      return { state: "found", orgId: ORG, holdState: empState === "held" ? "stopped" : null, holdId: empState === "held" ? HID : null };
    },
    org: async () => { orgReads++; return { state: "found", orgId: ORG, holdState: null, holdId: null }; },
  });
});

test("throttle map never grows past HOLD_THROTTLE_MAX_KEYS", () => {
  const m = new Map<string, number>();
  for (let i = 0; i < hold.HOLD_THROTTLE_MAX_KEYS + 250; i++) expect(hold.takeHoldThrottleSlot(m, `k${i}`, 60_000, 1_000)).toBe(true);
  expect(m.size).toBeLessThanOrEqual(hold.HOLD_THROTTLE_MAX_KEYS);
  expect(hold.takeHoldThrottleSlot(m, `k${hold.HOLD_THROTTLE_MAX_KEYS + 249}`, 60_000, 2_000)).toBe(false); // newest kept
});

test("wake_suppressed: one row per window per org × employee × reason; the rest are counted", () => {
  const key = `${ORG}:${EMP}:employee_on_hold`;
  expect(hold.takeWakeSuppressedAuditSlot(key).write).toBe(true);
  for (let i = 0; i < 50; i++) expect(hold.takeWakeSuppressedAuditSlot(key).write).toBe(false);
  expect(hold.takeWakeSuppressedAuditSlot(`${ORG}:other:employee_on_hold`).write).toBe(true);
  for (let i = 0; i < 2000; i++) hold.takeWakeSuppressedAuditSlot(`${ORG}:e${i}:employee_on_hold`);
  const sizes = hold.__holdThrottleSizesForTests();
  expect(sizes.wake).toBeLessThanOrEqual(hold.HOLD_THROTTLE_MAX_KEYS);
  expect(sizes.wakeCounts).toBeLessThanOrEqual(hold.HOLD_THROTTLE_MAX_KEYS);
});

test("within one request: G1 + G3 read once; the just-before-send check re-reads (4 reads, not 6)", async () => {
  await hold.withHoldRequestScope(async () => {
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" })).ok).toBe(true);
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(true);
    expect(await hold.preSendHoldCode(ORG, EMP)).toBeNull();
  });
  expect(empReads + orgReads).toBe(4);
});

test("a hold that lands mid-request is caught just before sending", async () => {
  await hold.withHoldRequestScope(async () => {
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" })).ok).toBe(true);
    empState = "held";
    expect(await hold.preSendHoldCode(ORG, EMP)).toBe("employee_on_hold");
  });
});

test("a read error is never reused: the next checkpoint re-reads and still fails stop", async () => {
  empState = "error";
  await hold.withHoldRequestScope(async () => {
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" })).ok).toBe(false);
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(false);
  });
  expect(empReads).toBe(2);
});

test("nothing outlives the request: a new request re-reads", async () => {
  await hold.withHoldRequestScope(() => hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" }));
  empState = "held";
  const r = await hold.withHoldRequestScope(() => hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" }));
  expect(r.ok).toBe(false);
});
