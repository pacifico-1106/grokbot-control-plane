import { test, expect, mock } from "bun:test";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
let member = { id: "member", orgId: "tenant", userId: "actual-user", role: "owner", status: "active", email: "ops@example.com" };
let user: Record<string, unknown> | null = { id: "actual-user", email: "outsider@example.com", email_confirmed_at: "2026-01-01" };
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/data/members", () => ({ listMembers: async () => [member] }));
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => ({ auth: { admin: { getUserById: async () => ({ data: { user }, error: null }) } } }) }));
const { assertPlatformOpsFromAdminCred } = await import("./platform-ops-gate");
const cred = { orgId: "tenant" } as ResolvedAdminCredential;
test("editable owner email cannot grant platform rights; confirmed Auth email remains compatible", async () => {
  process.env.SUPER_ADMIN_EMAILS = "ops@example.com";
  delete process.env.SUPER_ADMIN_USER_IDS;
  expect((await assertPlatformOpsFromAdminCred(cred)).allowed).toBe(false);
  user = { ...user, email: "ops@example.com" };
  expect((await assertPlatformOpsFromAdminCred(cred)).allowed).toBe(true);
  user = { ...user, email_confirmed_at: null };
  expect((await assertPlatformOpsFromAdminCred(cred)).allowed).toBe(false);
});
test("immutable ID works, disabled/deleted Auth account and membership are denied", async () => {
  process.env.SUPER_ADMIN_USER_IDS = "actual-user";
  expect((await assertPlatformOpsFromAdminCred(cred)).allowed).toBe(true);
  user = { ...user, banned_until: "2999-01-01" };
  expect((await assertPlatformOpsFromAdminCred(cred)).allowed).toBe(false);
  user = { ...user, banned_until: null };
  member = { ...member, status: "disabled" };
  expect((await assertPlatformOpsFromAdminCred(cred)).allowed).toBe(false);
  member = { ...member, status: "active" }; user = null;
  expect((await assertPlatformOpsFromAdminCred(cred)).allowed).toBe(false);
});
