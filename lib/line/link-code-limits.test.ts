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
function fake(gate: "ok" | "sender_locked" | "account_locked" = "ok", record: string = "recorded", opts: { gateThrows?: boolean } = {}) {
  const calls: Call[] = [];
  const backend: LinkCodeGuardBackend = {
    async gate(org, acct, sender) { calls.push(["gate", org, acct, sender]); if (opts.gateThrows) throw new Error("down"); return gate; },
    async recordFailure(org, acct, sender) { calls.push(["record", org, acct, sender]); return record as never; },
    async alertOps(p) { calls.push(["alert", p.orgId, p.accountKey, p.reason]); },
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
  test("no gate calls; wrong code → invalid_or_expired with no fixed reply", async () => {
    const f = fake();
    __setLineLinkCodeGuardBackendForTests(f.backend);
    const r = await redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER });
    expect(r).toEqual({ ok: false, reason: "invalid_or_expired", replyJa: null });
    expect(f.calls).toEqual([]);
  });
});

describe("limits ON", () => {
  beforeEach(() => { process.env.LINE_LINK_CODE_LIMITS_ENABLED = "true"; });

  test("right code: gate first, then redeem; per-channel account key; sender stored only as HMAC", async () => {
    const code = await issue();
    const f = fake();
    __setLineLinkCodeGuardBackendForTests(f.backend);
    const r = await redeemLineLinkCode({ orgId: ORG, channelId: CH, code, lineUserId: USER });
    expect(r).toEqual({ ok: true, memberId: "mem_1", issuedByUserId: "user-1" });
    expect(f.calls.length).toBe(1);
    const [op, org, acct, sender] = f.calls[0];
    expect([op, org, acct]).toEqual(["gate", ORG, `line_channel:${CH}`]);
    expect(sender).toMatch(/^[0-9a-f]{64}$/);
    expect(sender).not.toContain(USER);
  });

  test("wrong code: counted, one fixed reply", async () => {
    const f = fake();
    __setLineLinkCodeGuardBackendForTests(f.backend);
    const r = await redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER });
    expect(r).toEqual({ ok: false, reason: "invalid_or_expired", replyJa: LINK_CODE_FAILURE_REPLY_JA });
    expect(f.calls.map((c) => c[0])).toEqual(["gate", "record"]);
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

  test("the failure that locks the account alerts ops once (IDs only)", async () => {
    const f = fake("ok", "account_locked_new");
    __setLineLinkCodeGuardBackendForTests(f.backend);
    await redeemLineLinkCode({ orgId: ORG, channelId: CH, code: "ABCDEFGH", lineUserId: USER });
    expect(f.calls.find((c) => c[0] === "alert")).toEqual(["alert", ORG, `line_channel:${CH}`, "link_code_account_locked"]);
  });

  test("guard storage down → refused (fail closed), code not consumed, same reply", async () => {
    const code = await issue();
    __setLineLinkCodeGuardBackendForTests(fake("ok", "recorded", { gateThrows: true }).backend);
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
    const src = readFileSync(new URL("../../app/api/webhooks/line/[ref]/route.ts", import.meta.url), "utf8");
    expect(src).toContain("redeemLineLinkCode(");
    expect(src).not.toContain("consumeLineLinkCode(");
  });
});
