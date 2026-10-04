/**
 * 木村 2026-10-04 #4: when the owner-row insert fails during signup /
 * provisioning, no org row may be left behind. provisionOrgForUser creates
 * org + owner in ONE DB transaction (RPC provision_org_with_owner); if that
 * RPC is not deployed yet it falls back to the two-step insert with a
 * compensating delete of the new org.
 */
import { beforeEach, expect, mock, test } from "bun:test";

type Call = { table: string; op: string; arg?: unknown; filters: Array<[string, unknown]> };
let calls: Call[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResponse: { data: unknown; error: { message: string; code?: string } | null } = { data: null, error: null };
let memberInsertError: { message: string; code?: string } | null = null;
let existingMember: Record<string, unknown> | null = null;

const OWNER_ROW = {
  id: "m_new", org_id: "o_new", user_id: "u_1", email: "owner@fixture.invalid", display_name: "owner",
  role: "owner", job_role: "owner", status: "active",
  capabilities: ["view_dashboard", "view_employees", "view_audit", "approve_actions", "manage_spend_limits", "hire_issue_credentials", "manage_team", "manage_billing"],
};

mock.module("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
mock.module("../mode", () => ({ isDemoMode: () => false }));
mock.module("../data/audit", () => ({
  appendAuditEvent: async (e: unknown) => {
    calls.push({ table: "audit_events", op: "append", arg: e, filters: [] });
  },
}));
mock.module("../supabase", () => {
  const chain = (table: string) => {
    let op = "select";
    let arg: unknown;
    const filters: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.eq = (c: string, v: unknown) => {
      filters.push([c, v]);
      return q;
    };
    for (const m of ["insert", "update", "delete"]) {
      q[m] = (a?: unknown) => {
        op = m;
        arg = a;
        calls.push({ table, op, arg, filters });
        return q;
      };
    }
    q.maybeSingle = async () => ({ data: table === "org_members" && op === "select" ? existingMember : null, error: null });
    q.single = async () => {
      if (table === "orgs" && op === "insert") return { data: { id: "o_legacy" }, error: null };
      if (table === "org_members" && op === "insert") {
        return memberInsertError ? { data: null, error: memberInsertError } : { data: { ...OWNER_ROW, org_id: "o_legacy" }, error: null };
      }
      return { data: null, error: null };
    };
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return q;
  };
  return {
    createSupabaseAdminClient: () => ({
      from: chain,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return rpcResponse;
      },
    }),
    createSupabaseServerClient: () => null,
  };
});

beforeEach(() => {
  calls = [];
  rpcCalls = [];
  memberInsertError = null;
  existingMember = null;
  rpcResponse = { data: { created: true, org_id: "o_new", member: OWNER_ROW }, error: null };
});

const { provisionOrgForUser } = await import("./session");
const input = { userId: "u_1", email: "owner@fixture.invalid", orgName: "Fixture Org", displayName: "owner" };
const writes = (table: string, op?: string) => calls.filter((c) => c.table === table && (!op || c.op === op));

test("org + owner are created by ONE transactional RPC (no separate orgs / org_members inserts)", async () => {
  const r = await provisionOrgForUser({ ...input, referralCode: "aic-test", integrationMode: "byo" });
  expect(r.orgId).toBe("o_new");
  expect(r.member.role).toBe("owner");
  expect(rpcCalls.map((c) => c.fn)).toEqual(["provision_org_with_owner"]);
  const args = rpcCalls[0].args;
  expect(args.p_user_id).toBe("u_1");
  expect(args.p_email).toBe("owner@fixture.invalid");
  expect(args.p_org_name).toBe("Fixture Org");
  expect(args.p_integration_mode).toBe("byo");
  expect(args.p_referral_code).toBe("AIC-TEST");
  expect(args.p_capabilities).toEqual(OWNER_ROW.capabilities);
  expect(typeof args.p_trial_ends_at).toBe("string");
  expect(writes("orgs", "insert")).toEqual([]);
  expect(writes("org_members", "insert")).toEqual([]);
  // the rest of the bootstrap is unchanged
  expect(writes("subscriptions", "insert").length).toBe(1);
  expect(writes("gateway_links", "insert").length).toBe(1);
  expect(writes("audit_events").length).toBe(1);
});

test("member insert fails inside the RPC → error, and nothing else is written (no org row, no subscription)", async () => {
  rpcResponse = { data: null, error: { message: 'null value in column "email" violates not-null constraint', code: "23502" } };
  await expect(provisionOrgForUser(input)).rejects.toThrow(/not-null/);
  expect(calls.filter((c) => c.op !== "select")).toEqual([]);
});

test("RPC finds an existing active membership (concurrent provision) → returns it, no second bootstrap", async () => {
  rpcResponse = { data: { created: false, org_id: "o_existing", member: { ...OWNER_ROW, id: "m_existing", org_id: "o_existing" } }, error: null };
  const r = await provisionOrgForUser(input);
  expect(r.orgId).toBe("o_existing");
  expect(r.memberId).toBe("m_existing");
  expect(calls.filter((c) => c.op !== "select")).toEqual([]);
});

test("RPC not deployed yet → legacy two-step; member insert failure deletes the new org (compensating delete)", async () => {
  rpcResponse = { data: null, error: { message: "Could not find the function public.provision_org_with_owner in the schema cache", code: "PGRST202" } };
  memberInsertError = { message: "insert failed", code: "23514" };
  await expect(provisionOrgForUser(input)).rejects.toThrow(/insert failed/);
  const deletes = writes("orgs", "delete");
  expect(deletes.length).toBe(1);
  expect(deletes[0].filters).toContainEqual(["id", "o_legacy"]);
  expect(writes("subscriptions")).toEqual([]);
  expect(writes("gateway_links")).toEqual([]);
});

test("RPC not deployed yet → legacy two-step still provisions when the member insert succeeds", async () => {
  rpcResponse = { data: null, error: { message: "Could not find the function public.provision_org_with_owner in the schema cache", code: "PGRST202" } };
  const r = await provisionOrgForUser(input);
  expect(r.orgId).toBe("o_legacy");
  expect(writes("orgs", "delete")).toEqual([]);
  expect(writes("subscriptions", "insert").length).toBe(1);
});
