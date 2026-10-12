import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  LINK_CODE_FAILURE_REPLY_JA,
  linkCodeSenderKey,
  type LinkCodeGuardBackend,
  type LinkCodeReservation,
  withLinkCodeGuard,
} from "@/lib/comm/link-code-guard";

const KEY = "VOTER_BINDING_SECRET";
const saved = process.env[KEY];
beforeEach(() => { process.env[KEY] = "v".repeat(48); });
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

const ORG = "ec000000-0000-4000-8000-000000000001";
const ACCOUNT = "comm_account:ec200000-0000-4000-8000-000000000001";
const LINE_USER = "U" + "a".repeat(32);

type Calls = { reserve: unknown[][]; release: unknown[][]; ops: unknown[]; repeat: unknown[] };
function backend(res: LinkCodeReservation | (() => LinkCodeReservation) | "throw") {
  const calls: Calls = { reserve: [], release: [], ops: [], repeat: [] };
  const b: LinkCodeGuardBackend = {
    reserve: async (...a) => {
      calls.reserve.push(a);
      if (res === "throw") throw new Error("down");
      return typeof res === "function" ? res() : res;
    },
    release: async (...a) => { calls.release.push(a); },
    alertOps: async (p) => { calls.ops.push(p); },
    alertRepeat: async (p) => { calls.repeat.push(p); },
  };
  return { b, calls };
}
const OK: LinkCodeReservation = { result: "ok", attemptId: "11111111-1111-4111-8111-111111111111", notify: null };
const input = { orgId: ORG, accountKey: ACCOUNT, lineUserId: LINE_USER };
const wrong = async () => ({ ok: false as const, reason: "invalid_or_expired" });

describe("link-code guard (H8): one reservation BEFORE the code is compared", () => {
  test("sender key is a keyed HMAC — no raw LINE userId, differs per key, fails closed without a key", () => {
    const k1 = linkCodeSenderKey(ORG, LINE_USER);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).not.toContain(LINE_USER);
    process.env[KEY] = "w".repeat(48);
    expect(linkCodeSenderKey(ORG, LINE_USER)).not.toBe(k1);
    process.env[KEY] = "short";
    expect(() => linkCodeSenderKey(ORG, LINE_USER)).toThrow("link_code_guard_key_missing");
  });

  test("reserved first, then compared; a wrong code keeps the slot (counted), single reply", async () => {
    const { b, calls } = backend(OK);
    const order: string[] = [];
    const bb = { ...b, reserve: async (...a: [string, string, string]) => { order.push("reserve"); return b.reserve(...a); } };
    const r = await withLinkCodeGuard(bb, input, async () => { order.push("compare"); return wrong(); });
    expect(order).toEqual(["reserve", "compare"]);
    expect(r).toEqual({ ok: false, replyJa: LINK_CODE_FAILURE_REPLY_JA, reason: "invalid_or_expired" });
    expect(calls.release).toEqual([]);
  });

  test("a right code releases its slot (successes are not counted)", async () => {
    const { b, calls } = backend(OK);
    const r = await withLinkCodeGuard(b, input, async () => ({ ok: true as const, value: 7 }));
    expect(r).toEqual({ ok: true, value: 7 });
    expect(calls.release).toEqual([[ORG, OK.attemptId]]);
  });

  test("locked sender / account: the code is NOT compared, same reply", async () => {
    for (const result of ["sender_locked", "account_locked"] as const) {
      const { b } = backend({ result, attemptId: null, notify: null });
      let compared = false;
      const r = await withLinkCodeGuard(b, input, async () => { compared = true; return { ok: true as const, value: 1 }; });
      expect(compared).toBe(false);
      expect(r).toEqual({ ok: false, replyJa: LINK_CODE_FAILURE_REPLY_JA, reason: result });
    }
  });

  test("the reservation that locks the account alerts ops once (IDs only)", async () => {
    const { b, calls } = backend({ result: "account_locked", attemptId: null, notify: "account_locked" });
    await withLinkCodeGuard(b, input, wrong);
    expect(calls.ops).toEqual([{ orgId: ORG, accountKey: ACCOUNT, reason: "link_code_account_locked" }]);
    expect(calls.repeat).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain(LINE_USER);
  });

  test("the 3rd account lock within 24 h notifies ops AND the tenant's approvers (once — the DB says so once)", async () => {
    const { b, calls } = backend({ result: "account_locked", attemptId: null, notify: "account_locked_repeat" });
    await withLinkCodeGuard(b, input, wrong);
    expect(calls.ops).toEqual([{ orgId: ORG, accountKey: ACCOUNT, reason: "link_code_account_locked" }]);
    expect(calls.repeat).toEqual([{ orgId: ORG, accountKey: ACCOUNT, reason: "link_code_account_locked_repeat" }]);
  });

  test("guard storage down → refused (fail closed), code not compared", async () => {
    const { b } = backend("throw");
    let compared = false;
    const r = await withLinkCodeGuard(b, input, async () => { compared = true; return { ok: true as const, value: 1 }; });
    expect(compared).toBe(false);
    expect(r.ok === false && r.reason).toBe("guard_unavailable");
  });

  test("a storage error from the code lookup itself releases the slot (not counted as a wrong code)", async () => {
    const { b, calls } = backend(OK);
    const r = await withLinkCodeGuard(b, input, async () => ({ ok: false as const, reason: "storage_unavailable" }));
    expect(r.ok).toBe(false);
    expect(calls.release.length).toBe(1);
  });

  test("木村 10/12 [MED]: 20 concurrent wrong guesses → exactly 5 reach the comparison", async () => {
    // in-memory reservation with the SQL semantics: >= 5 in the window → sender_locked
    let slots = 0;
    const { b } = backend(() => (slots >= 5 ? { result: "sender_locked", attemptId: null, notify: null }
      : (slots++, { result: "ok", attemptId: `a-${slots}`, notify: null })));
    let compared = 0;
    const slowWrong = async () => { compared++; await new Promise((r) => setTimeout(r, 5)); return wrong(); };
    const results = await Promise.all(Array.from({ length: 20 }, () => withLinkCodeGuard(b, input, slowWrong)));
    expect(compared).toBe(5);
    expect(results.every((r) => !r.ok)).toBe(true);
  });
});
