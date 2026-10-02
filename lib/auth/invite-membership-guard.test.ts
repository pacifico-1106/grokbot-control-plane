import { expect, mock, test } from "bun:test";

/**
 * Org-membership guard: an invited Auth user with no active org_members row
 * must NOT be auto-provisioned a fresh owner org by /app (ensureAuthenticatedOrg).
 */
let inserts: string[] = [];
let memberRow: Record<string, unknown> | null = null;
let invitedAt: string | null = "2026-10-02T18:42:23Z";

mock.module("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
mock.module("../mode", () => ({ isDemoMode: () => false }));
mock.module("../supabase", () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "update"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: table === "org_members" ? memberRow : null, error: null });
    q.single = async () => ({ data: { id: `${table}_new` }, error: null });
    q.insert = (row: unknown) => {
      inserts.push(table);
      void row;
      return q;
    };
    return q;
  };
  return {
    createSupabaseAdminClient: () => ({ from: chain }),
    createSupabaseServerClient: () => ({
      auth: {
        getUser: async () => ({
          data: { user: { id: "u_invited", email: "invitee@example.com", invited_at: invitedAt } },
        }),
      },
    }),
  };
});

const { ensureAuthenticatedOrg, isInvitedWithoutMembership } = await import("./session");

test("invited user without active membership → no_membership, nothing inserted", async () => {
  inserts = [];
  memberRow = null;
  invitedAt = "2026-10-02T18:42:23Z";
  const r = await ensureAuthenticatedOrg();
  expect(r.status).toBe("no_membership");
  expect(inserts).toEqual([]);
});

test("non-invited (self-signup) user without org still gets repair-provisioned", async () => {
  inserts = [];
  memberRow = null;
  invitedAt = null;
  const r = await ensureAuthenticatedOrg();
  expect(r.status).not.toBe("no_membership");
  expect(inserts).toContain("orgs");
});

test("helper", () => {
  expect(isInvitedWithoutMembership({ demo: false, userId: "u", email: null, orgId: null, member: null, invited: true })).toBe(true);
  expect(isInvitedWithoutMembership({ demo: false, userId: "u", email: null, orgId: "o", member: null, invited: true })).toBe(false);
  expect(isInvitedWithoutMembership({ demo: false, userId: "u", email: null, orgId: null, member: null })).toBe(false);
});
