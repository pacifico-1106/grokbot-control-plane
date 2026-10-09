/**
 * Thread single-flight store (demo implementation; the SQL twin is tested by
 * tests/security/db-thread-single-flight.sql). One lease per org × thread key;
 * TTL; only the holder (same org + lease id) releases; another org's lease or
 * self-post record never interferes (BOLA). Self posts are per org × employee
 * × thread and only move forward.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetThreadGuardStoreForTests,
  acquireThreadLease,
  readLastSelfPost,
  readLatestAiPostAfter,
  recordSelfPost,
  releaseThreadLease,
} from "./store";
import { setThreadGuardClockForTests } from "./config";

const ORG_A = "00000000-0000-4000-8000-00000000aa01";
const ORG_B = "00000000-0000-4000-8000-00000000bb01";
const KEY = "a".repeat(64);
const KEY2 = "b".repeat(64);

let now = Date.parse("2026-10-09T12:00:00.000Z");
afterEach(() => {
  setThreadGuardClockForTests(null);
  __resetThreadGuardStoreForTests();
});
const tick = (ms: number) => {
  now += ms;
};

describe("lease", () => {
  test("one holder per org × thread; busy carries the remaining seconds", async () => {
    setThreadGuardClockForTests(() => now);
    const a = await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY, ttlSeconds: 60 });
    expect(a.state).toBe("acquired");
    const b = await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_2", threadKey: KEY, ttlSeconds: 60 });
    expect(b.state).toBe("busy");
    if (b.state === "busy") expect(b.retryAfterSeconds).toBe(60);
    expect((await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_2", threadKey: KEY2, ttlSeconds: 60 })).state).toBe("acquired");
  });

  test("expires after the TTL (a crashed holder never blocks forever)", async () => {
    setThreadGuardClockForTests(() => now);
    expect((await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY, ttlSeconds: 30 })).state).toBe("acquired");
    tick(29_000);
    expect((await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_2", threadKey: KEY, ttlSeconds: 30 })).state).toBe("busy");
    tick(1_000);
    expect((await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_2", threadKey: KEY, ttlSeconds: 30 })).state).toBe("acquired");
  });

  test("only the holder releases; an old holder cannot release a re-taken lease", async () => {
    setThreadGuardClockForTests(() => now);
    const first = await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY, ttlSeconds: 30 });
    tick(31_000);
    const second = await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_2", threadKey: KEY, ttlSeconds: 30 });
    expect(second.state).toBe("acquired");
    if (first.state !== "acquired" || second.state !== "acquired") return;
    expect(await releaseThreadLease({ orgId: ORG_A, threadKey: KEY, leaseId: first.leaseId })).toBe(false);
    expect((await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_3", threadKey: KEY, ttlSeconds: 30 })).state).toBe("busy");
    expect(await releaseThreadLease({ orgId: ORG_A, threadKey: KEY, leaseId: second.leaseId })).toBe(true);
    expect((await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_3", threadKey: KEY, ttlSeconds: 30 })).state).toBe("acquired");
  });

  test("BOLA: another org's lease on the same key never blocks; another org cannot release mine", async () => {
    const mine = await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY, ttlSeconds: 30 });
    expect((await acquireThreadLease({ orgId: ORG_B, employeeId: "emp_b", threadKey: KEY, ttlSeconds: 30 })).state).toBe("acquired");
    if (mine.state !== "acquired") throw new Error("setup");
    expect(await releaseThreadLease({ orgId: ORG_B, threadKey: KEY, leaseId: mine.leaseId })).toBe(false);
    expect((await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_2", threadKey: KEY, ttlSeconds: 30 })).state).toBe("busy");
  });

  test("12 concurrent acquires → exactly one holder", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => acquireThreadLease({ orgId: ORG_A, employeeId: `emp_${i}`, threadKey: KEY, ttlSeconds: 30 }))
    );
    expect(results.filter((r) => r.state === "acquired").length).toBe(1);
  });

  test("bad input → unavailable (fail closed)", async () => {
    expect((await acquireThreadLease({ orgId: ORG_A, employeeId: "emp_1", threadKey: "not-a-key", ttlSeconds: 30 })).state).toBe("unavailable");
    expect((await acquireThreadLease({ orgId: "", employeeId: "emp_1", threadKey: KEY, ttlSeconds: 30 })).state).toBe("unavailable");
  });
});

describe("self posts", () => {
  test("per org × employee × thread, only moves forward", async () => {
    await recordSelfPost({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY, micros: BigInt(2_000), jobKey: "j1" });
    await recordSelfPost({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY, micros: BigInt(1_000), jobKey: "j0" });
    expect(await readLastSelfPost({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY })).toEqual({ ok: true, post: { micros: BigInt(2_000), jobKey: "j1" } });
    expect(await readLastSelfPost({ orgId: ORG_A, employeeId: "emp_2", threadKey: KEY })).toEqual({ ok: true, post: null });
    expect(await readLastSelfPost({ orgId: ORG_B, employeeId: "emp_1", threadKey: KEY })).toEqual({ ok: true, post: null });
    expect(await readLastSelfPost({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY2 })).toEqual({ ok: true, post: null });
  });
});

describe("latest AI post in the thread (木村 decision 4: other AI employees of the same org count)", () => {
  const J1 = "1".repeat(64);
  const J2 = "2".repeat(64);
  test("newest post after the point by ANY employee of the org; the caller's same-job post is skipped", async () => {
    await recordSelfPost({ orgId: ORG_A, employeeId: "emp_1", threadKey: KEY, micros: BigInt(300), jobKey: J1 });
    await recordSelfPost({ orgId: ORG_A, employeeId: "emp_2", threadKey: KEY, micros: BigInt(200), jobKey: J2 });
    const any = await readLatestAiPostAfter({ orgId: ORG_A, threadKey: KEY, afterMicros: BigInt(100), excludeJobKey: null });
    expect(any).toEqual({ ok: true, post: { micros: BigInt(300), jobKey: J1, employeeId: "emp_1" } });
    // emp_1's own same-job post is exempt, emp_2's later post still counts
    const skip = await readLatestAiPostAfter({ orgId: ORG_A, threadKey: KEY, afterMicros: BigInt(100), excludeJobKey: J1 });
    expect(skip).toEqual({ ok: true, post: { micros: BigInt(200), jobKey: J2, employeeId: "emp_2" } });
    expect(await readLatestAiPostAfter({ orgId: ORG_A, threadKey: KEY, afterMicros: BigInt(300), excludeJobKey: null })).toEqual({ ok: true, post: null });
  });
  test("BOLA: another org's posts on the same key never count", async () => {
    await recordSelfPost({ orgId: ORG_B, employeeId: "emp_b", threadKey: KEY, micros: BigInt(900), jobKey: null });
    expect(await readLatestAiPostAfter({ orgId: ORG_A, threadKey: KEY, afterMicros: BigInt(1), excludeJobKey: null })).toEqual({ ok: true, post: null });
  });
  test("bad input → not ok (fail closed)", async () => {
    expect((await readLatestAiPostAfter({ orgId: ORG_A, threadKey: "x", afterMicros: BigInt(1), excludeJobKey: null })).ok).toBe(false);
  });
});
