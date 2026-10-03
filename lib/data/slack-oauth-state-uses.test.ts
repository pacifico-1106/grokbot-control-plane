/**
 * Review 3: expired slack_oauth_state_uses rows are removed on write (opportunistic).
 * Supabase path with a fake client (no network); demo path via the in-memory map.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type Call = { table: string; op: string; filters: Array<[string, string, unknown]>; row?: unknown };
const calls: Call[] = [];
let demo = false;
let deleteError: { message: string } | null = null;
let insertError: { message: string } | null = null;

mock.module("@/lib/mode", () => ({ isDemoMode: () => demo }));
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    from(table: string) {
      return {
        insert(row: unknown) {
          calls.push({ table, op: "insert", filters: [], row });
          return Promise.resolve({ error: insertError });
        },
        delete() {
          const call: Call = { table, op: "delete", filters: [] };
          calls.push(call);
          const chain = {
            lt(col: string, value: unknown) {
              call.filters.push(["lt", col, value]);
              return Promise.resolve({ error: deleteError });
            },
          };
          return chain;
        },
      };
    },
  }),
}));

const mod = await import("@/lib/data/slack-oauth-state-uses");

beforeEach(() => {
  calls.length = 0;
  demo = false;
  deleteError = null;
  insertError = null;
  mod.resetDemoSlackOAuthStateUses();
});

describe("slack_oauth_state_uses cleanup", () => {
  test("supabase: each consume first deletes rows expired more than the grace period ago, then inserts", async () => {
    const now = Date.parse("2026-10-04T02:00:00Z");
    const ok = await mod.consumeSlackOAuthStateNonce({ purpose: "shared_approval_install", nonce: "n1", orgId: "org_x", expiresAtMs: now + 600_000, nowMs: now });
    expect(ok).toBe(true);
    const del = calls.find((c) => c.op === "delete")!;
    expect(del.table).toBe("slack_oauth_state_uses");
    expect(del.filters).toEqual([["lt", "expires_at", new Date(now - mod.SLACK_OAUTH_STATE_USE_RETENTION_MS).toISOString()]]);
    expect(calls.map((c) => c.op)).toEqual(["delete", "insert"]);
    // Grace >= the state TTL: an expired-but-recent nonce row is kept (state verify already refuses it).
    expect(mod.SLACK_OAUTH_STATE_USE_RETENTION_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  test("supabase: a cleanup error never blocks (or allows) the single-use check", async () => {
    deleteError = { message: "boom" };
    expect(await mod.consumeSlackOAuthStateNonce({ purpose: "shared_approval_install", nonce: "n2", orgId: "org_x", expiresAtMs: Date.now() + 1000 })).toBe(true);
    insertError = { message: "duplicate key" };
    expect(await mod.consumeSlackOAuthStateNonce({ purpose: "shared_approval_install", nonce: "n2", orgId: "org_x", expiresAtMs: Date.now() + 1000 })).toBe(false);
  });

  test("demo: expired entries are dropped on the next write; live ones stay single-use", async () => {
    demo = true;
    const now = Date.now();
    expect(await mod.consumeSlackOAuthStateNonce({ purpose: "p", nonce: "old", orgId: "o", expiresAtMs: now - mod.SLACK_OAUTH_STATE_USE_RETENTION_MS - 1000, nowMs: now - 10 })).toBe(true);
    expect(await mod.consumeSlackOAuthStateNonce({ purpose: "p", nonce: "live", orgId: "o", expiresAtMs: now + 600_000, nowMs: now })).toBe(true);
    expect(mod.demoSlackOAuthStateUseCountForTests()).toBe(1);
    expect(await mod.consumeSlackOAuthStateNonce({ purpose: "p", nonce: "live", orgId: "o", expiresAtMs: now + 600_000, nowMs: now })).toBe(false);
  });
});
