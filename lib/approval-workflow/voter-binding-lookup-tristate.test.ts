/**
 * lookupVoterBindingMember: found / none / error are distinct (#299 木村 review).
 * getMemberIdFromVoterBinding keeps its existing contract (null for none AND error).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type Result = { data: unknown; error: unknown };
let next: Result = { data: null, error: null };
let adminAvailable = true;
let lastFilters: Record<string, unknown> = {};

const builder = () => {
  const b = {
    select: () => b,
    eq: (col: string, v: unknown) => { lastFilters[col] = v; return b; },
    maybeSingle: async () => next,
  };
  return b;
};
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => (adminAvailable ? { from: () => builder() } : null),
  createSupabaseServerClient: () => null,
}));

const envKeys = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const backup = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test-project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-unit-test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-unit-test";
afterAll(() => {
  for (const k of envKeys) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

const { lookupVoterBindingMember, getMemberIdFromVoterBinding } = await import("@/lib/approval-workflow/data");
const ext = { provider: "telegram" as const, channelKey: "nc_1", userId: "111" };
const future = new Date(Date.now() + 3600_000).toISOString();

beforeEach(() => {
  next = { data: null, error: null };
  adminAvailable = true;
  lastFilters = {};
});

describe("lookupVoterBindingMember tri-state", () => {
  test("DB error → error (not none)", async () => {
    next = { data: null, error: { message: "boom" } };
    expect(await lookupVoterBindingMember("org_a", ext)).toEqual({ status: "error" });
    expect(await getMemberIdFromVoterBinding("org_a", ext)).toBeNull();
  });

  test("admin client unavailable → error", async () => {
    adminAvailable = false;
    expect(await lookupVoterBindingMember("org_a", ext)).toEqual({ status: "error" });
  });

  test("no row → none", async () => {
    expect(await lookupVoterBindingMember("org_a", ext)).toEqual({ status: "none" });
  });

  test("revoked / unverified / expired → none", async () => {
    for (const row of [
      { member_id: "m1", revoked_at: "2026-01-01T00:00:00Z", verified_at: "2026-01-01T00:00:00Z" },
      { member_id: "m1", verified_at: null },
      { member_id: "m1", verified_at: "2026-01-01T00:00:00Z", expires_at: "2020-01-01T00:00:00Z" },
    ]) {
      next = { data: row, error: null };
      expect(await lookupVoterBindingMember("org_a", ext)).toEqual({ status: "none" });
    }
  });

  test("valid binding → found, scoped to the caller's org (BOLA)", async () => {
    next = { data: { member_id: "m1", verified_at: "2026-01-01T00:00:00Z", expires_at: future }, error: null };
    expect(await lookupVoterBindingMember("org_a", ext)).toEqual({ status: "found", memberId: "m1" });
    expect(lastFilters.org_id).toBe("org_a");
    expect(lastFilters.channel_key).toBe("nc_1");
    expect(await getMemberIdFromVoterBinding("org_a", ext)).toBe("m1");
  });
});
