/**
 * D11 (八坂 GO 2026-10-05): the per-host verification-POST budget (30 / min /
 * host) is shared across instances through mcp_event_verification_windows
 * (migration 20261005000000) — one atomic RPC per challenge over a fixed
 * 1-minute window, no read-then-write. If the table / RPC can't be reached
 * the challenge is refused (fail closed, retryable). Production mode with a
 * mocked service-role client; dummy values, no network.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type RpcRes = { data: unknown; error: unknown } | "throw";
let rpcRes: RpcRes = { data: true, error: null };
let clientAvailable = true;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const deleteCalls: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
let deleteRes: { data: unknown; error: unknown } = { data: [{ host: "a" }, { host: "b" }], error: null };
function fakeClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (rpcRes === "throw") throw new Error("fetch failed");
      return rpcRes;
    },
    from(table: string) {
      const call = { table, filters: [] as Array<[string, string, unknown]> };
      const chain: Record<string, unknown> = {};
      chain.delete = () => { deleteCalls.push(call); return chain; };
      for (const m of ["lt", "eq", "lte"]) chain[m] = (c: string, v: unknown) => { call.filters.push([m, c, v]); return chain; };
      chain.select = async () => deleteRes;
      return chain;
    },
  };
}
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => (clientAvailable ? fakeClient() : null) }));

const saved = { u: process.env.NEXT_PUBLIC_SUPABASE_URL, a: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, s: process.env.SUPABASE_SERVICE_ROLE_KEY };
function prodMode() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test-project.supabase.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "unit-test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-service-role-key";
}
function demoMode() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}
afterAll(() => {
  for (const [k, v] of [["NEXT_PUBLIC_SUPABASE_URL", saved.u], ["NEXT_PUBLIC_SUPABASE_ANON_KEY", saved.a], ["SUPABASE_SERVICE_ROLE_KEY", saved.s]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
const store = await import("@/lib/mcp-events/store");
const NOW = Date.parse("2026-10-05T00:01:23.456Z");

beforeEach(() => {
  rpcCalls.length = 0; deleteCalls.length = 0; rpcRes = { data: true, error: null }; clientAvailable = true;
  store.__resetMcpEventsStoreForTests();
});

describe("production: shared fixed-window budget through one atomic RPC", () => {
  test("one rpc per challenge: host lower-cased, window start = minute floor, limit 30", async () => {
    prodMode();
    expect(await store.takeVerificationBudget("Hooks.Example.ORG", NOW, 30)).toBe("ok");
    expect(rpcCalls).toEqual([{ fn: "mcp_events_take_verification_budget", args: { p_host: "hooks.example.org", p_window_start: "2026-10-05T00:01:00.000Z", p_limit: 30 } }]);
  });
  test("rpc false → limited; no in-memory fallback lets a later call through", async () => {
    prodMode();
    rpcRes = { data: false, error: null };
    expect(await store.takeVerificationBudget("a.example.org", NOW, 30)).toBe("limited");
    expect(await store.takeVerificationBudget("a.example.org", NOW + 1, 30)).toBe("limited");
    expect(rpcCalls).toHaveLength(2);
  });
  test("fail closed: rpc error / throw / no client / non-boolean answer → unavailable", async () => {
    prodMode();
    rpcRes = { data: null, error: { message: "relation \"mcp_event_verification_windows\" does not exist", code: "42P01" } };
    expect(await store.takeVerificationBudget("a.example.org", NOW, 30)).toBe("unavailable");
    rpcRes = "throw";
    expect(await store.takeVerificationBudget("a.example.org", NOW, 30)).toBe("unavailable");
    rpcRes = { data: "true", error: null };
    expect(await store.takeVerificationBudget("a.example.org", NOW, 30)).toBe("unavailable");
    rpcRes = { data: null, error: null };
    expect(await store.takeVerificationBudget("a.example.org", NOW, 30)).toBe("unavailable");
    clientAvailable = false;
    expect(await store.takeVerificationBudget("a.example.org", NOW, 30)).toBe("unavailable");
  });
  test("prune deletes windows that started before the cutoff (single delete, no read)", async () => {
    prodMode();
    expect(await store.deleteVerificationWindowsBefore("2026-10-05T00:00:00.000Z")).toBe(2);
    expect(deleteCalls).toEqual([{ table: "mcp_event_verification_windows", filters: [["lt", "window_start", "2026-10-05T00:00:00.000Z"]] }]);
    deleteRes = { data: null, error: { message: "boom" } };
    await expect(store.deleteVerificationWindowsBefore("2026-10-05T00:00:00.000Z")).rejects.toThrow("mcp_events_store_error");
    deleteRes = { data: [{ host: "a" }, { host: "b" }], error: null };
  });
});

describe("demo: same fixed-window semantics in memory", () => {
  test("30 per host per minute window; other hosts independent; next window resets", async () => {
    demoMode();
    for (let i = 0; i < 30; i++) expect(await store.takeVerificationBudget("a.example.org", NOW + i, 30)).toBe("ok");
    expect(await store.takeVerificationBudget("A.example.org", NOW + 31, 30)).toBe("limited");
    expect(await store.takeVerificationBudget("b.example.org", NOW, 30)).toBe("ok");
    expect(await store.takeVerificationBudget("a.example.org", Date.parse("2026-10-05T00:02:00.000Z"), 30)).toBe("ok");
    expect(rpcCalls).toHaveLength(0);
  });
  test("demo prune removes old windows", async () => {
    demoMode();
    await store.takeVerificationBudget("a.example.org", NOW, 30);
    expect(await store.deleteVerificationWindowsBefore("2026-10-05T00:01:00.000Z")).toBe(0);
    expect(await store.deleteVerificationWindowsBefore("2026-10-05T00:02:00.000Z")).toBe(1);
  });
});
