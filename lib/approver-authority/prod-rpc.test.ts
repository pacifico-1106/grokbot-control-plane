/**
 * PR-D, production code paths against a fake Supabase admin client (fixture
 * env only; fetch stays blocked by the no-network preload):
 * - W1 RPC: flag OFF sends exactly today's 7 arguments; flag ON adds
 *   p_enforce_approver_authority and surfaces the RPC reason; RPC error → fail closed.
 * - approver_authority_check: requester ids passed; error / garbage → approver_unverified.
 * - createApproval: insert failure with a requirement never falls back to the legacy insert.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";

type Call = { kind: "rpc" | "from"; name: string; args?: Record<string, unknown>; ops: string[] };
let calls: Call[] = [];
let rpcResponder: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown } = () => ({ data: null, error: null });
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
    return Promise.resolve(rpcResponder(name, args));
  },
  from: (table: string) => builder(table),
};

const mocks = scopedModuleMocks();
await mocks.mock("@/lib/supabase", { createSupabaseAdminClient: () => fakeClient });

const { resolveApprovalWithoutWorkflowDetailed, createApproval } = await import("@/lib/data/approvals");
const { checkApproverAuthority } = await import("@/lib/approver-authority/verify");

const ENV_KEYS = ["APPROVER_AUTHORITY_ENABLED", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const ORG = "00000000-0000-4000-8000-00000000d0a1";
const OWNER = "00000000-0000-4000-8000-00000000d0b1";
const TICKET = "00000000-0000-4000-8000-00000000d0c1";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture-project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-anon-key-not-real";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key-not-real";
  calls = [];
  rpcResponder = () => ({ data: null, error: null });
  tableResponder = () => ({ data: null, error: null });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const row = (over: Record<string, unknown> = {}) => ({
  id: TICKET, org_id: ORG, purpose: "admin.policy", summary: "s", risk: "high", status: "pending", tool: "plan.upgrade",
  title: "t", created_at: new Date().toISOString(), required_approver_kind: "owner", approver_authority: {},
  metadata: { auditClass: "admin", approvalClass: "admin", adminTool: "plan.upgrade", requesterMemberId: "00000000-0000-4000-8000-00000000d0b9",
    adminRequester: { kind: "admin_agent", actorId: "agent_fixture", grokBotAgentId: "grok_fixture" } },
  ...over,
});
const w1Calls = () => calls.filter((c) => c.kind === "rpc" && c.name === "resolve_approval_w1_checked");

describe("resolve_approval_w1_checked", () => {
  test("flag OFF: exactly today's 7 arguments", async () => {
    delete process.env.APPROVER_AUTHORITY_ENABLED;
    tableResponder = (table) => (table === "approval_requests" ? { data: row(), error: null } : { data: null, error: null });
    rpcResponder = () => ({ data: { ok: true }, error: null });
    await resolveApprovalWithoutWorkflowDetailed(TICKET, "approved", "fixture", ORG, { memberId: OWNER, actorId: OWNER });
    expect(Object.keys(w1Calls()[0].args!).sort()).toEqual(
      ["p_actor", "p_decision", "p_decision_id", "p_id", "p_member_id", "p_org", "p_revision_note"]
    );
  });

  test("flag ON: enforce flag sent; the RPC reason is surfaced; RPC error fails closed", async () => {
    process.env.APPROVER_AUTHORITY_ENABLED = "true";
    tableResponder = (table) => (table === "approval_requests" ? { data: row(), error: null } : { data: null, error: null });
    for (const reason of ["owner_approval_required", "no_owner_other_than_requester", "approver_is_requester"]) {
      calls = [];
      rpcResponder = () => ({ data: { ok: false, reason }, error: null });
      const r = await resolveApprovalWithoutWorkflowDetailed(TICKET, "approved", "fixture", ORG, { memberId: OWNER, actorId: OWNER });
      expect(r).toEqual({ approval: null, reason });
      expect(w1Calls()[0].args!.p_enforce_approver_authority).toBe(true);
    }
    rpcResponder = () => ({ data: null, error: { message: "boom" } });
    expect((await resolveApprovalWithoutWorkflowDetailed(TICKET, "approved", "fixture", ORG, { memberId: OWNER })).reason).toBe("approver_unverified");
    // reject is never gated: no enforce flag
    calls = [];
    rpcResponder = () => ({ data: { ok: true }, error: null });
    await resolveApprovalWithoutWorkflowDetailed(TICKET, "rejected", "fixture", ORG, { memberId: OWNER });
    expect("p_enforce_approver_authority" in w1Calls()[0].args!).toBe(false);
  });
});

describe("approver_authority_check", () => {
  test("requester ids are passed; errors and garbage fail closed", async () => {
    rpcResponder = () => ({ data: { outcome: "allow", approver_role: "owner" }, error: null });
    expect(await checkApproverAuthority({ orgId: ORG, memberId: OWNER, requiredKind: "owner", requesterMemberIds: ["r1"] }))
      .toEqual({ outcome: "allow", approverRole: "owner" });
    const args = calls.find((c) => c.name === "approver_authority_check")!.args!;
    expect(args).toEqual({ p_org: ORG, p_member_id: OWNER, p_required_kind: "owner", p_requester_ids: ["r1"] });
    rpcResponder = () => ({ data: { outcome: "deny", reason: "no_owner_other_than_requester" }, error: null });
    expect(await checkApproverAuthority({ orgId: ORG, memberId: null, requiredKind: "owner" }))
      .toEqual({ outcome: "deny", reason: "no_owner_other_than_requester" });
    rpcResponder = () => ({ data: null, error: { message: "boom" } });
    expect(await checkApproverAuthority({ orgId: ORG, memberId: OWNER, requiredKind: "owner" })).toEqual({ outcome: "deny", reason: "approver_unverified" });
    rpcResponder = () => ({ data: { outcome: "allow", approver_role: "superuser" }, error: null });
    expect(await checkApproverAuthority({ orgId: ORG, memberId: OWNER, requiredKind: "owner" })).toEqual({ outcome: "deny", reason: "approver_unverified" });
    rpcResponder = () => { throw new Error("network"); };
    expect(await checkApproverAuthority({ orgId: ORG, memberId: OWNER, requiredKind: "owner" })).toEqual({ outcome: "deny", reason: "approver_unverified" });
  });
});

describe("createApproval", () => {
  const input = {
    orgId: ORG, employeeId: "", credentialId: "", title: "t", purpose: "admin.policy", summary: "s", risk: "high" as const,
    tool: "plan.upgrade", jobId: "job_pd_fixture", metadata: { auditClass: "admin", adminTool: "plan.upgrade", adminMutation: { planKey: "proper" } },
  };
  const inserts = () => calls.filter((c) => c.kind === "from" && c.name === "approval_requests" && c.ops.includes("insert"));

  test("flag ON: insert failure throws, no legacy retry (requirement never lost)", async () => {
    process.env.APPROVER_AUTHORITY_ENABLED = "true";
    tableResponder = (table, ops) => (table === "approval_requests" && ops.includes("insert") ? { data: null, error: { message: "column missing" } } : { data: null, error: null });
    await expect(createApproval(input)).rejects.toThrow("approval_create_failed_approver_authority");
    expect(inserts().length).toBe(1);
  });

  test("flag OFF: legacy retry as today", async () => {
    delete process.env.APPROVER_AUTHORITY_ENABLED;
    tableResponder = (table, ops) => (table === "approval_requests" && ops.includes("insert") ? { data: null, error: { message: "column missing" } } : { data: null, error: null });
    await expect(createApproval(input)).rejects.toThrow("column missing");
    expect(inserts().length).toBe(2);
  });
});
