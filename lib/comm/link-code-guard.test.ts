import { afterEach, describe, expect, test } from "bun:test";
import {
  LINK_CODE_FAILURE_REPLY_JA,
  linkCodeSenderKey,
  type LinkCodeGuardBackend,
  withLinkCodeGuard,
} from "@/lib/comm/link-code-guard";

const KEY = "VOTER_BINDING_SECRET";
const saved = process.env[KEY];
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

const ORG = "ec000000-0000-4000-8000-000000000001";
const ACCOUNT = "ec200000-0000-4000-8000-000000000001";
const LINE_USER = "U" + "a".repeat(32);

function backend(gate: string, record = "recorded") {
  const calls: { gate: unknown[][]; record: unknown[][]; alerts: unknown[] } = { gate: [], record: [], alerts: [] };
  const b: LinkCodeGuardBackend = {
    gate: async (...a) => {
      calls.gate.push(a);
      return gate as never;
    },
    recordFailure: async (...a) => {
      calls.record.push(a);
      return record as never;
    },
    alertOps: async (payload) => {
      calls.alerts.push(payload);
    },
  };
  return { b, calls };
}

describe("link-code guard (H8)", () => {
  test("sender key is a keyed HMAC — no raw LINE userId, differs per key, fails closed without a key", () => {
    process.env[KEY] = "s".repeat(40);
    const k1 = linkCodeSenderKey(ORG, LINE_USER);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).not.toContain(LINE_USER.slice(1, 10));
    expect(linkCodeSenderKey(ORG, LINE_USER)).toBe(k1);
    expect(linkCodeSenderKey("ec000000-0000-4000-8000-000000000002", LINE_USER)).not.toBe(k1);
    process.env[KEY] = "t".repeat(40);
    expect(linkCodeSenderKey(ORG, LINE_USER)).not.toBe(k1);
    delete process.env[KEY];
    expect(() => linkCodeSenderKey(ORG, LINE_USER)).toThrow("link_code_guard_key_missing");
  });

  test("locked sender: the code is NOT looked up, same single reply as a wrong code", async () => {
    process.env[KEY] = "s".repeat(40);
    for (const g of ["sender_locked", "account_locked"]) {
      const { b, calls } = backend(g);
      let consumed = 0;
      const r = await withLinkCodeGuard(b, { orgId: ORG, accountKey: ACCOUNT, lineUserId: LINE_USER }, async () => {
        consumed++;
        return { ok: true as const, value: "member-1" };
      });
      expect(consumed).toBe(0);
      expect(r).toEqual({ ok: false, replyJa: LINK_CODE_FAILURE_REPLY_JA, reason: g });
      expect(calls.record.length).toBe(0);
    }
  });

  test("wrong code: one failure recorded, single reply text", async () => {
    process.env[KEY] = "s".repeat(40);
    const { b, calls } = backend("ok");
    const r = await withLinkCodeGuard(b, { orgId: ORG, accountKey: ACCOUNT, lineUserId: LINE_USER }, async () => ({
      ok: false as const,
      reason: "invalid_or_expired",
    }));
    expect(r).toEqual({ ok: false, replyJa: LINK_CODE_FAILURE_REPLY_JA, reason: "invalid_or_expired" });
    expect(calls.record.length).toBe(1);
    expect(calls.record[0][0]).toBe(ORG);
    expect(calls.record[0][1]).toBe(ACCOUNT);
    expect(calls.record[0][2]).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.alerts.length).toBe(0);
  });

  test("the failure that locks the account alerts ops once — IDs only, no LINE userId", async () => {
    process.env[KEY] = "s".repeat(40);
    const { b, calls } = backend("ok", "account_locked_new");
    await withLinkCodeGuard(b, { orgId: ORG, accountKey: ACCOUNT, lineUserId: LINE_USER }, async () => ({
      ok: false as const,
      reason: "invalid_or_expired",
    }));
    expect(calls.alerts).toEqual([{ orgId: ORG, accountKey: ACCOUNT, reason: "link_code_account_locked" }]);
    expect(JSON.stringify(calls.alerts)).not.toContain(LINE_USER);
  });

  test("a storage error is not counted as a wrong code and the code is not consumed? — it is refused (fail closed)", async () => {
    process.env[KEY] = "s".repeat(40);
    const b: LinkCodeGuardBackend = {
      gate: async () => {
        throw new Error("db down");
      },
      recordFailure: async () => "recorded",
      alertOps: async () => undefined,
    };
    let consumed = 0;
    const r = await withLinkCodeGuard(b, { orgId: ORG, accountKey: ACCOUNT, lineUserId: LINE_USER }, async () => {
      consumed++;
      return { ok: true as const, value: "m" };
    });
    expect(consumed).toBe(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("guard_unavailable");
  });

  test("a right code when not locked passes through, nothing recorded", async () => {
    process.env[KEY] = "s".repeat(40);
    const { b, calls } = backend("ok");
    const r = await withLinkCodeGuard(b, { orgId: ORG, accountKey: ACCOUNT, lineUserId: LINE_USER }, async () => ({
      ok: true as const,
      value: "member-1",
    }));
    expect(r).toEqual({ ok: true, value: "member-1" });
    expect(calls.record.length).toBe(0);
  });

  test("a storage error from the code lookup itself is not counted as a wrong code", async () => {
    process.env[KEY] = "s".repeat(40);
    const { b, calls } = backend("ok");
    const r = await withLinkCodeGuard(b, { orgId: ORG, accountKey: ACCOUNT, lineUserId: LINE_USER }, async () => ({
      ok: false as const,
      reason: "storage_unavailable",
    }));
    expect(r.ok).toBe(false);
    expect(calls.record.length).toBe(0);
  });
});
