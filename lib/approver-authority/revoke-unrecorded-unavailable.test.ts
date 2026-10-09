/**
 * 木村 2026-10-10 00:55 item 2(b): the two revoke-unrecorded APIs before
 * migration 20261005500000 is in production.
 *
 * The owner route asks Postgres (approver_authority_check) whether the caller
 * is an owner. Before the migration that RPC does not exist (PostgREST
 * PGRST202 / Postgres 42883). It used to come back as a plain 403
 * actor_not_owner ("you are not the owner") — safe, but wrong and confusing
 * for a real owner. Now: approver_authority_unavailable (503) with a nextStep,
 * the ticket is never touched, and nothing is audited. Not gated on the flag:
 * the recovery must keep working if the flag is turned OFF after tickets got
 * stuck while it was ON (the RPC exists then).
 *
 * The operator route never calls the RPC; before the migration no ticket can
 * be in the stuck state, so it stays 409 not_recoverable without writing.
 * Production code paths against a fake Supabase admin client (fixture env).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";

type Call = { kind: "rpc" | "from"; name: string; args?: Record<string, unknown>; ops: string[] };
let calls: Call[] = [];
let rpcResponder: (name: string) => { data: unknown; error: unknown } = () => ({ data: null, error: null });
let tableResponder: (table: string, ops: string[]) => { data: unknown; error: unknown } = () => ({ data: null, error: null });

function builder(table: string) {
  const call: Call = { kind: "from", name: table, ops: [] };
  calls.push(call);
  const result = () => Promise.resolve(tableResponder(table, call.ops));
  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => result().then(ok, bad);
      if (prop === "maybeSingle" || prop === "single") return () => { call.ops.push(prop); return result(); };
      return () => { call.ops.push(prop); return proxy; };
    },
  });
  return proxy;
}
const fakeClient = {
  rpc: (name: string, args: Record<string, unknown>) => {
    calls.push({ kind: "rpc", name, args, ops: [] });
    return Promise.resolve(rpcResponder(name));
  },
  from: (table: string) => builder(table),
};

const ORG = "00000000-0000-4000-8000-00000000e0a1";
const OWNER = "00000000-0000-4000-8000-00000000e0b1";
const TICKET = "00000000-0000-4000-8000-00000000e0c1";

const mocks = scopedModuleMocks();
await mocks.mock("@/lib/supabase", { createSupabaseAdminClient: () => fakeClient });
await mocks.mock("@/lib/auth/session", { getCurrentOrgId: async () => ORG });
await mocks.mock("@/lib/approver-authority/web-direct", { webSessionActorMemberId: async () => OWNER });
await mocks.mock("@/lib/admin/access", {
  getSuperAdminAccess: async () => ({ allowed: true, actor: { email: "ops@platform.example" } }),
});

const { revokeUnrecordedApproval } = await import("@/lib/approver-authority/recovery");
const { POST: ownerRevokePost } = await import("@/app/api/approvals/[id]/revoke-unrecorded/route");
const { POST: operatorRevokePost } = await import("@/app/api/admin/organizations/[orgId]/approvals/[approvalId]/revoke-unrecorded/route");

const ENV_KEYS = ["APPROVER_AUTHORITY_ENABLED", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture-project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-anon-key-not-real";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key-not-real";
  delete process.env.APPROVER_AUTHORITY_ENABLED;
  calls = [];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A pre-migration production row: none of the PR-D columns exist. */
const preMigrationRow = () => ({
  id: TICKET, org_id: ORG, purpose: "admin.policy", summary: "s", risk: "high", status: "approved", tool: "policy.patch",
  title: "t", created_at: new Date().toISOString(), metadata: { approvalClass: "admin", adminTool: "policy.patch" },
});
/** A stuck ticket after the migration (approved, class set, no approver, not fulfilled). */
const stuckRow = () => ({ ...preMigrationRow(), required_approver_kind: "owner_or_designated_admin", approver_member_id: null, approver_authority: {} });

const writes = () => calls.filter((c) => c.kind === "from" && c.ops.some((op) => op === "update" || op === "insert" || op === "upsert"));
const ownerPost = () =>
  ownerRevokePost(new Request(`http://localhost/api/approvals/${TICKET}/revoke-unrecorded`, { method: "POST" }), {
    params: Promise.resolve({ id: TICKET }),
  });
const operatorPost = () =>
  operatorRevokePost(new Request(`http://localhost/api/admin/organizations/${ORG}/approvals/${TICKET}/revoke-unrecorded`, { method: "POST" }), {
    params: Promise.resolve({ orgId: ORG, approvalId: TICKET }),
  });

describe("owner route, approver_authority_check missing (migration 20261005500000 not applied)", () => {
  for (const [label, error] of [
    ["PostgREST PGRST202", { code: "PGRST202", message: "Could not find the function public.approver_authority_check" }],
    ["Postgres 42883", { code: "42883", message: "function public.approver_authority_check does not exist" }],
  ] as const) {
    for (const flag of ["OFF", "ON"] as const) {
      test(`${label}, flag ${flag} → approver_authority_unavailable (503) with nextStep; nothing written`, async () => {
        if (flag === "ON") process.env.APPROVER_AUTHORITY_ENABLED = "true";
        tableResponder = (table) => (table === "approval_requests" ? { data: preMigrationRow(), error: null } : { data: null, error: null });
        rpcResponder = () => ({ data: null, error });
        const core = await revokeUnrecordedApproval({ orgId: ORG, approvalId: TICKET, actor: { kind: "owner", memberId: OWNER } });
        expect(core).toEqual({ ok: false, code: "approver_authority_unavailable" });
        const res = await ownerPost();
        expect(res.status).toBe(503);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.ok).toBe(false);
        expect(body.error).toBe("approver_authority_unavailable");
        expect(String(body.message)).toContain("20261005500000");
        expect(typeof body.nextStep).toBe("string");
        expect(String(body.nextStep).length).toBeGreaterThan(0);
        expect(writes()).toEqual([]);
      });
    }
  }

  test("any other RPC error is still fail closed as actor_not_owner (403), nothing written", async () => {
    tableResponder = (table) => (table === "approval_requests" ? { data: stuckRow(), error: null } : { data: null, error: null });
    rpcResponder = () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    const res = await ownerPost();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("actor_not_owner");
    expect(writes()).toEqual([]);
  });

  test("RPC present and the caller is an owner (flag OFF): the stuck ticket is revoked as before", async () => {
    tableResponder = (table, ops) =>
      table === "approval_requests"
        ? { data: ops.includes("update") ? { ...stuckRow(), status: "rejected" } : stuckRow(), error: null }
        : { data: null, error: null };
    rpcResponder = (name) =>
      name === "approver_authority_check" ? { data: { outcome: "allow", approver_role: "owner" }, error: null } : { data: null, error: null };
    const res = await ownerPost();
    expect(res.status).toBe(200);
    expect(writes().some((c) => c.name === "approval_requests" && c.ops.includes("update"))).toBe(true);
  });
});

describe("operator route before the migration", () => {
  test("never calls approver_authority_check; no ticket can be stuck yet → 409 not_recoverable, nothing written", async () => {
    tableResponder = (table) => (table === "approval_requests" ? { data: preMigrationRow(), error: null } : { data: null, error: null });
    rpcResponder = () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
    const res = await operatorPost();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_recoverable");
    expect(calls.some((c) => c.kind === "rpc" && c.name === "approver_authority_check")).toBe(false);
    expect(writes()).toEqual([]);
  });
});
