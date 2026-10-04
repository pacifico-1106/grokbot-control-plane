/**
 * Invite activation in the /app gate (ensureAuthenticatedOrg): an invited Auth
 * user with no active membership gets their pending invite bound (DB RPC) and
 * lands in the inviting org; nothing else changes. Never auto-provisions an
 * org for invited users. Flag OFF = previous behaviour exactly.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let rpcCalls: string[] = [];
let inserts: string[] = [];
let memberRow: Record<string, unknown> | null = null;
let invitedAt: string | null = "2026-10-04T10:00:00Z";
let claimResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };

const BOUND = {
  id: "m_invited", org_id: "o_inviter", user_id: "u_invited", email: "invitee@fixture.invalid",
  display_name: "Invitee", role: "admin", job_role: "sales", capabilities: ["view_dashboard", "manage_team"], status: "active",
};

mock.module("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
mock.module("../mode", () => ({ isDemoMode: () => false }));
mock.module("../supabase", () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "update", "delete"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: table === "org_members" ? memberRow : null, error: null });
    q.single = async () => ({ data: { id: `${table}_new` }, error: null });
    q.insert = () => {
      inserts.push(table);
      return q;
    };
    return q;
  };
  return {
    createSupabaseAdminClient: () => ({
      from: chain,
      rpc: async (fn: string) => {
        rpcCalls.push(fn);
        if (fn === "claim_member_invites") {
          // The bound row becomes visible after a claim (ours, or a concurrent tab's).
          const d = claimResult.data as { status?: string; reason?: string } | null;
          if (d?.status === "claimed" || d?.reason === "has_active_membership") memberRow = BOUND;
          return claimResult;
        }
        return { data: { created: true, org_id: "o_new", member: { ...BOUND, id: "m_new", org_id: "o_new", role: "owner" } }, error: null };
      },
    }),
    createSupabaseServerClient: () => ({
      auth: {
        getUser: async () => ({
          data: { user: { id: "u_invited", email: "invitee@fixture.invalid", invited_at: invitedAt } },
        }),
      },
    }),
  };
});

const FLAG = "MEMBER_INVITE_ACTIVATION_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => {
  rpcCalls = [];
  inserts = [];
  memberRow = null;
  invitedAt = "2026-10-04T10:00:00Z";
  claimResult = { data: { status: "claimed", member_id: "m_invited", org_id: "o_inviter" }, error: null };
  process.env[FLAG] = "true";
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const { ensureAuthenticatedOrg } = await import("./session");

test("flag ON: invited user's pending invite is bound → ok in the inviting org, exactly as invited", async () => {
  const r = await ensureAuthenticatedOrg();
  expect(r.status).toBe("ok");
  if (r.status !== "ok") return;
  expect(r.session.orgId).toBe("o_inviter");
  expect(r.session.member?.id).toBe("m_invited");
  expect(r.session.member?.role).toBe("admin");
  expect(r.session.member?.capabilities).toEqual(["view_dashboard", "manage_team"]);
  expect(rpcCalls).toEqual(["claim_member_invites"]);
  expect(inserts).toEqual([]);
});

test("flag ON: nothing to claim → no_membership; never provisions an org", async () => {
  claimResult = { data: { status: "none", reason: "no_pending_invite" }, error: null };
  const r = await ensureAuthenticatedOrg();
  expect(r.status).toBe("no_membership");
  expect(rpcCalls).toEqual(["claim_member_invites"]);
  expect(inserts).toEqual([]);
});

test("flag ON: claim RPC error → no_membership (fail closed)", async () => {
  claimResult = { data: null, error: { message: "function public.claim_member_invites(uuid) does not exist" } };
  const r = await ensureAuthenticatedOrg();
  expect(r.status).toBe("no_membership");
  expect(inserts).toEqual([]);
  expect(rpcCalls).not.toContain("provision_org_with_owner");
});

test("flag ON: a concurrent tab already bound it (has_active_membership) → re-read → ok", async () => {
  claimResult = { data: { status: "none", reason: "has_active_membership" }, error: null };
  const r = await ensureAuthenticatedOrg();
  expect(r.status).toBe("ok");
  if (r.status === "ok") expect(r.session.member?.id).toBe("m_invited");
  expect(inserts).toEqual([]);
});

test("flag OFF: invited user → no_membership, claim RPC never called (unchanged)", async () => {
  delete process.env[FLAG];
  const r = await ensureAuthenticatedOrg();
  expect(r.status).toBe("no_membership");
  expect(rpcCalls).toEqual([]);
  expect(inserts).toEqual([]);
});

test("flag ON: non-invited (self-signup) user → no claim; normal repair-provisioning", async () => {
  invitedAt = null;
  const r = await ensureAuthenticatedOrg();
  expect(r.status).toBe("ok");
  expect(rpcCalls).not.toContain("claim_member_invites");
});

test("flag ON: user who already has an active membership → no claim call", async () => {
  memberRow = { ...BOUND, id: "m_existing", org_id: "o_existing" };
  const r = await ensureAuthenticatedOrg();
  expect(r.status).toBe("ok");
  expect(rpcCalls).toEqual([]);
});
