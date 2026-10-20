/**
 * L-3: #228's LINE link codes go through the brute-force limits of L-1
 * (lib/comm/link-code-guard, migration 20261013200000). Design §5 / H8.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LINK_CODE_FAILURE_REPLY_JA, type LinkCodeGuardBackend } from "@/lib/comm/link-code-guard";
import { issueLineLinkCode, resetDemoLineLinkCodes } from "@/lib/line/link-code";
import {
  __setLineLinkCodeGuardBackendForTests,
  isLineLinkCodeLimitsEnabled,
  redeemLineLinkCode,
} from "@/lib/line/link-code-limits";

const ENV = ["LINE_LINK_CODE_LIMITS_ENABLED", "COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "VOTER_BINDING_SECRET"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const ORG = "org-a";
const CH = "chn-line-a";
const USER = "U" + "a".repeat(32);

type Call = [string, ...string[]];
type Res = "ok" | "sender_locked" | "account_locked";
function fake(result: Res = "ok", notify: null | "account_locked" | "account_locked_repeat" = null, opts: { reserveThrows?: boolean } = {}) {
  const calls: Call[] = [];
  const backend: LinkCodeGuardBackend = {
    async reserve(org, acct, sender) {
      calls.push(["reserve", org, acct, sender]);
      if (opts.reserveThrows) throw new Error("down");
      return { result, attemptId: result === "ok" ? "att-1" : null, notify };
    },
    async release(org, id) { calls.push(["release", org, id]); },
    async alertOps(p) { calls.push(["alert", p.orgId, p.accountKey, p.reason]); },
    async alertRepeat(p) { calls.push(["repeat", p.orgId, p.accountKey, p.reason]); },
  };
  return { backend, calls };
}

async function issue() {
  const r = await issueLineLinkCode({ orgId: ORG, channelId: CH, memberId: "mem_1", issuedByUserId: "user-1" });
  if (!r.ok) throw new Error(r.reason);
  return r.code;
}

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.VOTER_BINDING_SECRET = "v".repeat(48);
});
afterEach(() => {
  __setLineLinkCodeGuardBackendForTests(null);
  resetDemoLineLinkCodes();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("flag", () => {
  test("default OFF; LINE_LINK_CODE_LIMITS_ENABLED turns it on; LINE conversation forces it on", () => {
    expect(isLineLinkCodeLimitsEnabled()).toBe(false);
    process.env.LINE_LINK_CODE_LIMITS_ENABLED = "true";
    expect(isLineLinkCodeLimitsEnabled()).toBe(true);
    delete process.env.LINE_LINK_CODE_LIMITS_ENABLED;
    process.env.COMM_ACCOUNTS_ENABLED = "true";
    process.env.LINE_CONVERSATION_ENABLED = "true";
    expect(isLineLinkCodeLimitsEnabled()).toBe(true);
  });
});

describe("limits OFF: today's #228 behavior", () => {
  test("no guard calls; wrong code → invalid_or_expired with no fixed reply", async () => {
    const f = fake();
    __setLineLinkCodeGuardBackendForTests(f.backend);
    const r = await redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER });
    expect(r).toEqual({ ok: false, reason: "invalid_or_expired", replyJa: null });
    expect(f.calls).toEqual([]);
  });
});

describe("limits ON", () => {
  beforeEach(() => { process.env.LINE_LINK_CODE_LIMITS_ENABLED = "true"; });

  test("right code: one reservation first, then redeem, then the slot is given back; per-channel account key; sender only as HMAC", async () => {
    const code = await issue();
    const f = fake();
    __setLineLinkCodeGuardBackendForTests(f.backend);
    const r = await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER });
    expect(r).toEqual({ ok: true, memberId: "mem_1", issuedByUserId: "user-1" });
    expect(f.calls.map((c) => c[0])).toEqual(["reserve", "release"]);
    const [op, org, acct, sender] = f.calls[0];
    expect([op, org, acct]).toEqual(["reserve", ORG, `line_channel:${CH}`]);
    expect(sender).toMatch(/^[0-9a-f]{64}$/);
    expect(sender).not.toContain(USER);
  });

  test("wrong code: the reserved slot stays counted, one fixed reply", async () => {
    const f = fake();
    __setLineLinkCodeGuardBackendForTests(f.backend);
    const r = await redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER });
    expect(r).toEqual({ ok: false, reason: "invalid_or_expired", replyJa: LINK_CODE_FAILURE_REPLY_JA });
    expect(f.calls.map((c) => c[0])).toEqual(["reserve"]);
  });

  test("locked sender is refused even with the right code, and the code is NOT consumed", async () => {
    const code = await issue();
    const locked = fake("sender_locked");
    __setLineLinkCodeGuardBackendForTests(locked.backend);
    expect(await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER }))
      .toEqual({ ok: false, reason: "sender_locked", replyJa: LINK_CODE_FAILURE_REPLY_JA });
    // after the lock the same code still works (it was never looked up)
    __setLineLinkCodeGuardBackendForTests(fake().backend);
    expect((await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER })).ok).toBe(true);
  });

  test("locked account (channel) refuses everyone with the same reply", async () => {
    const code = await issue();
    __setLineLinkCodeGuardBackendForTests(fake("account_locked").backend);
    expect(await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER }))
      .toEqual({ ok: false, reason: "account_locked", replyJa: LINK_CODE_FAILURE_REPLY_JA });
  });

  test("the attempt that locks the account alerts ops once (IDs only); the 3rd lock in 24 h also the approvers", async () => {
    const f = fake("account_locked", "account_locked");
    __setLineLinkCodeGuardBackendForTests(f.backend);
    await redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER });
    expect(f.calls.filter((c) => c[0] !== "reserve")).toEqual([["alert", ORG, `line_channel:${CH}`, "link_code_account_locked"]]);
    const g = fake("account_locked", "account_locked_repeat");
    __setLineLinkCodeGuardBackendForTests(g.backend);
    await redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER });
    expect(g.calls.filter((c) => c[0] !== "reserve")).toEqual([
      ["alert", ORG, `line_channel:${CH}`, "link_code_account_locked"],
      ["repeat", ORG, `line_channel:${CH}`, "link_code_account_locked_repeat"],
    ]);
  });

  test("guard storage down → refused (fail closed), code not consumed, same reply", async () => {
    const code = await issue();
    __setLineLinkCodeGuardBackendForTests(fake("ok", null, { reserveThrows: true }).backend);
    expect(await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER }))
      .toEqual({ ok: false, reason: "guard_unavailable", replyJa: LINK_CODE_FAILURE_REPLY_JA });
    __setLineLinkCodeGuardBackendForTests(fake().backend);
    expect((await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER })).ok).toBe(true);
  });

  test("no guard backend at all → refused (fail closed)", async () => {
    __setLineLinkCodeGuardBackendForTests("none");
    const code = await issue();
    expect((await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER })))
      .toEqual({ ok: false, reason: "guard_unavailable", replyJa: LINK_CODE_FAILURE_REPLY_JA });
  });

  test("demo backend: 20 concurrent wrong codes → only 5 compared, then the sender is locked; another sender is unaffected", async () => {
    __setLineLinkCodeGuardBackendForTests(null);
    const rs = await Promise.all(Array.from({ length: 20 }, () => redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER })));
    expect(rs.filter((r) => !r.ok && r.reason === "invalid_or_expired").length).toBe(5);
    expect(rs.filter((r) => !r.ok && r.reason === "sender_locked").length).toBe(15);
  });

  test("demo backend: right codes do not count toward the lock", async () => {
    __setLineLinkCodeGuardBackendForTests(null);
    for (let i = 0; i < 6; i++) {
      const code = await issue();
      expect((await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER })).ok).toBe(true);
    }
  });

  test("demo backend: 5 wrong codes lock the sender; another sender is unaffected", async () => {
    __setLineLinkCodeGuardBackendForTests(null); // demo mode → in-memory backend
    for (let i = 0; i < 5; i++) await redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER });
    const code = await issue();
    expect(await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER })).toEqual({ ok: false, reason: "sender_locked", replyJa: LINK_CODE_FAILURE_REPLY_JA });
    expect((await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: "U" + "b".repeat(32) })).ok).toBe(true);
  });
});

describe("webhook route uses the guarded redeem", () => {
  test("route imports redeemLineLinkCode, not consumeLineLinkCode", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./approval-events.ts", import.meta.url), "utf8");
    expect(src).toContain("redeemLineLinkCode(");
    expect(src).not.toContain("consumeLineLinkCode(");
  });
});
