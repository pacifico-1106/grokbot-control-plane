/**
 * Hash-only send ledger (demo store; the production RPC is covered by
 * tests/security/db-comm-reply-dedup.sql). Isolation by org and by employee,
 * window, exact vs similar, release on failure, superseded-after-approval.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  claimCommReplySend,
  demoCommReplySendsForTests,
  finishCommReplySend,
  findRecentCommReplyDuplicate,
  resetDemoCommReplySends,
} from "./comm-reply-sends";
import { setCommReplyDedupClockForTests } from "@/lib/comm-reply-dedup/config";

const H = (c: string) => c.repeat(64);
const SK = (fill: number, changed = 0) =>
  Array.from({ length: 128 }, (_, i) => (i < changed ? fill + 1000 + i : fill));

const base = {
  orgId: "org_a",
  employeeId: "emp_a",
  conversationKey: H("a"),
  bodyHash: H("1"),
  sketch: SK(7),
  tool: "comm.reply",
  windowSeconds: 30 * 60,
  similarityThreshold: 0.6 as number | null,
  retentionSeconds: 48 * 3600,
};

let now = Date.parse("2026-10-04T08:45:00Z");
afterEach(() => {
  resetDemoCommReplySends();
  setCommReplyDedupClockForTests(null);
  now = Date.parse("2026-10-04T08:45:00Z");
});
setCommReplyDedupClockForTests(() => now);

async function sent(input = base) {
  const c = await claimCommReplySend(input);
  expect(c.state).toBe("claimed");
  if (c.state === "claimed") await finishCommReplySend({ id: c.id, orgId: input.orgId, outcome: "sent" });
  return c;
}

describe("claimCommReplySend", () => {
  test("second identical send within the window is a duplicate (exact)", async () => {
    setCommReplyDedupClockForTests(() => now);
    await sent();
    now += 60_000;
    const again = await claimCommReplySend(base);
    expect(again).toMatchObject({ state: "duplicate", match: "exact", similarity: 1 });
  });

  test("outside the window it is claimed again", async () => {
    setCommReplyDedupClockForTests(() => now);
    await sent();
    now += 31 * 60_000;
    expect((await claimCommReplySend(base)).state).toBe("claimed");
  });

  test("similar body: duplicate in similar mode, claimed in exact mode (threshold null)", async () => {
    setCommReplyDedupClockForTests(() => now);
    await sent();
    const close = { ...base, bodyHash: H("2"), sketch: SK(7, 30) }; // 98/128 ≈ 0.77
    expect(await claimCommReplySend(close)).toMatchObject({ state: "duplicate", match: "similar" });
    expect((await claimCommReplySend({ ...close, similarityThreshold: null })).state).toBe("claimed");
  });

  test("other org / other employee / other conversation are isolated", async () => {
    setCommReplyDedupClockForTests(() => now);
    await sent();
    expect((await claimCommReplySend({ ...base, orgId: "org_b" })).state).toBe("claimed");
    expect((await claimCommReplySend({ ...base, employeeId: "emp_b" })).state).toBe("claimed");
    expect((await claimCommReplySend({ ...base, conversationKey: H("b") })).state).toBe("claimed");
  });

  test("a reserved (in-flight) claim already blocks a concurrent identical send", async () => {
    setCommReplyDedupClockForTests(() => now);
    const [a, b] = await Promise.all([claimCommReplySend(base), claimCommReplySend(base)]);
    expect([a.state, b.state].sort()).toEqual(["claimed", "duplicate"]);
  });

  test("failed delivery releases the claim; uncertain keeps it", async () => {
    setCommReplyDedupClockForTests(() => now);
    const c = await claimCommReplySend(base);
    if (c.state !== "claimed") throw new Error("expected claim");
    await finishCommReplySend({ id: c.id, orgId: base.orgId, outcome: "failed" });
    const c2 = await claimCommReplySend(base);
    expect(c2.state).toBe("claimed");
    if (c2.state !== "claimed") throw new Error("expected claim");
    await finishCommReplySend({ id: c2.id, orgId: base.orgId, outcome: "uncertain" });
    expect((await claimCommReplySend(base)).state).toBe("duplicate");
  });

  test("approval fulfill: a reply about another matter sent after the approval was created does NOT supersede (木村)", async () => {
    setCommReplyDedupClockForTests(() => now);
    const createdAt = new Date(now).toISOString();
    now += 18_000;
    await sent({ ...base, bodyHash: H("9"), sketch: SK(99) }); // a different body (similarity 0)
    now += 17 * 60_000;
    const res = await claimCommReplySend({ ...base, approvalId: "apr_1", approvalCreatedAt: createdAt });
    expect(res.state).toBe("claimed");
  });

  test("approval fulfill: a similar or identical reply sent after the approval was created → superseded (with match)", async () => {
    setCommReplyDedupClockForTests(() => now);
    const createdAt = new Date(now).toISOString();
    now += 18_000;
    await sent({ ...base, bodyHash: H("2"), sketch: SK(7, 30) }); // re-written: 98/128 ≈ 0.77
    // 45 min later: outside the 30 min duplicate window, still "after the approval"
    now += 45 * 60_000;
    expect(await claimCommReplySend({ ...base, approvalId: "apr_1", approvalCreatedAt: createdAt })).toMatchObject({
      state: "superseded",
      match: "similar",
    });
    // identical body → exact
    await sent({ ...base, bodyHash: H("4"), sketch: SK(44) });
    now += 60_000;
    expect(
      await claimCommReplySend({ ...base, bodyHash: H("4"), sketch: SK(44), approvalId: "apr_2", approvalCreatedAt: createdAt })
    ).toMatchObject({ state: "superseded", match: "exact", similarity: 1 });
    // exact mode (threshold null): only an identical body supersedes
    expect(
      (await claimCommReplySend({ ...base, similarityThreshold: null, approvalId: "apr_3", approvalCreatedAt: createdAt })).state
    ).toBe("claimed");
  });

  test("approval fulfill: a reply sent BEFORE the approval was created never supersedes (the dedup window decides)", async () => {
    setCommReplyDedupClockForTests(() => now);
    await sent();
    now += 60_000;
    const later = await claimCommReplySend({
      ...base, bodyHash: H("3"), sketch: SK(3), approvalId: "apr_2", approvalCreatedAt: new Date(now).toISOString(),
    });
    expect(later.state).toBe("claimed");
  });

  test("ledger rows hold only hashes / sketch / ids (no body)", async () => {
    setCommReplyDedupClockForTests(() => now);
    await sent();
    const rows = demoCommReplySendsForTests();
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["approvalId", "bodyHash", "conversationKey", "createdAtMs", "employeeId", "id", "orgId", "sketch", "state", "tool"].sort()
    );
  });
});

describe("findRecentCommReplyDuplicate (read-only pre-check)", () => {
  test("reports a duplicate without writing", async () => {
    setCommReplyDedupClockForTests(() => now);
    await sent();
    const before = demoCommReplySendsForTests().length;
    expect(await findRecentCommReplyDuplicate(base)).toMatchObject({ state: "duplicate", match: "exact" });
    expect(await findRecentCommReplyDuplicate({ ...base, orgId: "org_b" })).toEqual({ state: "none" });
    expect(demoCommReplySendsForTests().length).toBe(before);
  });
});
