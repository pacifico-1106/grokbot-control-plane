/**
 * credentials.last_used_at: conditional UPDATE via touch_credential_last_used
 * (at most once per 5 minutes per credential). Best-effort; never fails auth.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type RpcRes = { data: unknown; error: unknown } | "throw" | "hang";
let rpcRes: RpcRes = { data: "2026-10-16T00:00:00.000Z", error: null };
let clientAvailable = true;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
function fakeClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (rpcRes === "throw") throw new Error("fetch failed");
      if (rpcRes === "hang") return new Promise(() => {});
      return rpcRes;
    },
  };
}
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => (clientAvailable ? fakeClient() : null),
}));

const saved = {
  u: process.env.NEXT_PUBLIC_SUPABASE_URL,
  a: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  s: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
function prodMode() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test-project.supabase.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "unit-test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-service-role-key";
}
function demoMode() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}
afterAll(() => {
  for (const [k, v] of [
    ["NEXT_PUBLIC_SUPABASE_URL", saved.u],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", saved.a],
    ["SUPABASE_SERVICE_ROLE_KEY", saved.s],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { touchCredentialLastUsed, CREDENTIAL_LAST_USED_MIN_INTERVAL, CREDENTIAL_LAST_USED_TIMEOUT_MS } = await import(
  "./credential-last-used"
);

const CRED = "bb200000-0000-4000-8000-000000000001";

beforeEach(() => {
  rpcCalls.length = 0;
  rpcRes = { data: "2026-10-16T00:00:00.000Z", error: null };
  clientAvailable = true;
});

describe("touchCredentialLastUsed", () => {
  test("5-minute throttle interval is the RPC default the SQL function uses", () => {
    expect(CREDENTIAL_LAST_USED_MIN_INTERVAL).toBe("00:05:00");
  });

  test("demo mode: no RPC", async () => {
    demoMode();
    await touchCredentialLastUsed(CRED);
    expect(rpcCalls).toEqual([]);
  });

  test("production: one conditional UPDATE RPC with credential id only", async () => {
    prodMode();
    await touchCredentialLastUsed(CRED);
    expect(rpcCalls).toEqual([
      { fn: "touch_credential_last_used", args: { p_id: CRED } },
    ]);
  });

  test("null / empty / non-uuid: no RPC", async () => {
    prodMode();
    await touchCredentialLastUsed(null);
    await touchCredentialLastUsed("");
    await touchCredentialLastUsed("cred_sales");
    expect(rpcCalls).toEqual([]);
  });

  test("rpc throw / missing client never throws", async () => {
    prodMode();
    rpcRes = "throw";
    await expect(touchCredentialLastUsed(CRED)).resolves.toBeUndefined();
    clientAvailable = false;
    rpcCalls.length = 0;
    await expect(touchCredentialLastUsed(CRED)).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([]);
  });

  test("timeout is bounded so a hung UPDATE cannot stall auth", () => {
    expect(CREDENTIAL_LAST_USED_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CREDENTIAL_LAST_USED_TIMEOUT_MS).toBeLessThanOrEqual(500);
  });

  test("hanging RPC times out and never throws", async () => {
    prodMode();
    rpcRes = "hang";
    const started = Date.now();
    await expect(touchCredentialLastUsed(CRED)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(CREDENTIAL_LAST_USED_TIMEOUT_MS + 250);
  });
});
