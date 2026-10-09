/**
 * TOCTOU follow-up, production code paths against a fake Supabase admin
 * client (fixture env only; fetch stays blocked by the no-network preload):
 * - a guarded write goes ONLY through the compare-and-swap RPC (row lock +
 *   compare + write in one transaction); there is no table update beside it;
 * - RPC says approver_context_changed → ApproverContextChangedError, no fallback write;
 * - RPC error / garbage → fail closed (no fallback write);
 * - no guard (flag OFF) → today's table writes, the RPC is never called;
 * - the guard reads the judged columns org-scoped and pins them as the expected snapshot.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";

type Call = { kind: "rpc" | "from"; name: string; args?: Record<string, unknown>; ops: string[]; opArgs: unknown[][] };
let calls: Call[] = [];
let rpcResponder: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown } = () => ({ data: null, error: null });
let tableResponder: (table: string, ops: string[]) => { data: unknown; error: unknown } = () => ({ data: null, error: null });

function builder(table: string) {
  const call: Call = { kind: "from", name: table, ops: [], opArgs: [] };
  calls.push(call);
  const result = () => Promise.resolve(tableResponder(table, call.ops));
  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => result().then(ok, bad);
      if (prop === "maybeSingle" || prop === "single") return () => { call.ops.push(prop); return result(); };
      return (...args: unknown[]) => { call.ops.push(prop); call.opArgs.push(args); return proxy; };
    },
  });
  return proxy;
}
const fakeClient = {
  rpc: (name: string, args: Record<string, unknown>) => {
    calls.push({ kind: "rpc", name, args, ops: [], opArgs: [] });
    return Promise.resolve(rpcResponder(name, args));
  },
  from: (table: string) => builder(table),
};

const mocks = scopedModuleMocks();
await mocks.mock("@/lib/supabase", { createSupabaseAdminClient: () => fakeClient });

const { updateEmployeePolicy } = await import("@/lib/data/employees");
const { setOrgSchedulingPolicy, setEmployeeSchedulingPolicy } = await import("@/lib/data/scheduling-policy");
const { ApproverContextChangedError } = await import("@/lib/approver-authority/context-cas");
const { approverContextGuardForWrite, readApproverContextSnapshot, approverContextFingerprint } = await import("@/lib/approver-authority/filing");

const ENV_KEYS = ["APPROVER_AUTHORITY_ENABLED", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const ORG = "00000000-0000-4000-8000-00000000ca01";
const EMP = "00000000-0000-4000-8000-00000000ca02";
const TICKET = "00000000-0000-4000-8000-00000000ca03";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture-project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-anon-key-not-real";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key-not-real";
  process.env.APPROVER_AUTHORITY_ENABLED = "true";
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

const policyGuard = {
  approvalId: TICKET, tool: "policy.patch" as const, fingerprint: "f".repeat(64), employeeId: EMP,
  expected: { scopes: ["mail:draft"], approval_policy: "always_human", action_limits: {}, tool_approval_defaults: { "commerce.order": "deny" } },
};
const schedulingGuard = (employeeId: string | null) => ({
  approvalId: TICKET, tool: "schedulingPolicy.patch" as const, fingerprint: "e".repeat(64), employeeId,
  expected: employeeId ? { org: null, employee: null } : { org: null },
});
const policyInput = () => ({
  orgId: ORG, employeeId: EMP, scopes: ["mail:draft"] as never, allowedPurposes: ["sales.outreach"], approvalPolicy: "always_human" as const,
  actionLimits: { "mail.send": { perDay: 3 } } as never,
});
const tableWrites = () => calls.filter((c) => c.kind === "from" && c.ops.some((op) => op === "update" || op === "insert" || op === "upsert" || op === "delete"));
const casCalls = (name: string) => calls.filter((c) => c.kind === "rpc" && c.name === name);
const employeeRow = { id: EMP, org_id: ORG, display_name: "E", role_label: "r", scopes: ["mail:draft"], allowed_purposes: ["sales.outreach"],
  approval_policy: "always_human", action_limits: { "mail.send": { perDay: 3 } }, tool_approval_defaults: {}, sod_level: "ok" };

describe("policy.patch write (employees + active credentials)", () => {
  test("concurrent change → RPC refuses → approver_context_changed; no table write at all", async () => {
    rpcResponder = () => ({ data: { ok: false, reason: "approver_context_changed" }, error: null });
    const error = await updateEmployeePolicy({ ...policyInput(), contextGuard: policyGuard }).catch((e: unknown) => e);
    expect(error instanceof ApproverContextChangedError).toBe(true);
    expect((error as Error).message).toBe("approver_context_changed");
    const [cas] = casCalls("approver_cas_write_employee_policy");
    expect(cas.args).toMatchObject({
      p_org: ORG, p_employee: EMP, p_approval: TICKET, p_fingerprint: policyGuard.fingerprint, p_expected: policyGuard.expected,
      p_scopes: ["mail:draft"], p_allowed_purposes: ["sales.outreach"], p_approval_policy: "always_human",
      p_action_limits: { "mail.send": { perDay: 3 } }, p_tool_approval_defaults: null,
    });
    expect(typeof cas.args!.p_sod_level).toBe("string");
    expect(tableWrites()).toEqual([]);
  });

  test("unchanged → the RPC writes; the result is mapped from the returned row; no separate table write", async () => {
    rpcResponder = () => ({ data: { ok: true, employee: employeeRow }, error: null });
    const updated = await updateEmployeePolicy({ ...policyInput(), contextGuard: policyGuard });
    expect(updated?.id).toBe(EMP);
    expect(updated?.actionLimits).toEqual({ "mail.send": { perDay: 3 } } as never);
    expect(casCalls("approver_cas_write_employee_policy").length).toBe(1);
    expect(tableWrites()).toEqual([]);
  });

  test("RPC error or unknown answer → fail closed, no fallback write", async () => {
    for (const answer of [{ data: null, error: { message: "boom" } }, { data: { ok: "yes" }, error: null }, { data: null, error: null }]) {
      calls = [];
      rpcResponder = () => answer;
      await expect(updateEmployeePolicy({ ...policyInput(), contextGuard: policyGuard })).rejects.toThrow();
      expect(tableWrites()).toEqual([]);
    }
  });

  test("RPC refuses for another reason (e.g. approval not approved) → that code, no write", async () => {
    rpcResponder = () => ({ data: { ok: false, reason: "approval_not_approved" }, error: null });
    await expect(updateEmployeePolicy({ ...policyInput(), contextGuard: policyGuard })).rejects.toThrow("approval_not_approved");
    expect(tableWrites()).toEqual([]);
  });

  test("a guarded write refuses fields the CAS does not cover (never half-guarded)", async () => {
    await expect(updateEmployeePolicy({ ...policyInput(), spend: null, contextGuard: policyGuard })).rejects.toThrow("context_guard_unsupported_fields");
    expect(calls.filter((c) => c.kind === "rpc")).toEqual([]);
    expect(tableWrites()).toEqual([]);
  });

  test("no guard (flag OFF path) → today's table writes; the CAS RPC is never called", async () => {
    tableResponder = (table) => (table === "employees" ? { data: employeeRow, error: null } : { data: null, error: null });
    await updateEmployeePolicy(policyInput());
    expect(casCalls("approver_cas_write_employee_policy")).toEqual([]);
    expect(tableWrites().map((c) => c.name)).toEqual(["employees", "credentials"]);
  });
});

describe("schedulingPolicy.patch write", () => {
  test("org target: refused → approver_context_changed, no orgs update", async () => {
    rpcResponder = () => ({ data: { ok: false, reason: "approver_context_changed" }, error: null });
    await expect(setOrgSchedulingPolicy(ORG, { policyName: "P", rules: [] } as never, { contextGuard: schedulingGuard(null) })).rejects.toThrow("approver_context_changed");
    const [cas] = casCalls("approver_cas_write_scheduling_policy");
    expect(cas.args).toMatchObject({ p_org: ORG, p_employee: null, p_approval: TICKET, p_target: "org", p_expected: { org: null } });
    expect(tableWrites()).toEqual([]);
  });

  test("employee clearOverride: p_target employee, p_policy null; ok → no separate update", async () => {
    rpcResponder = () => ({ data: { ok: true }, error: null });
    await setEmployeeSchedulingPolicy(EMP, ORG, null, { contextGuard: schedulingGuard(EMP) });
    const [cas] = casCalls("approver_cas_write_scheduling_policy");
    expect(cas.args).toMatchObject({ p_org: ORG, p_employee: EMP, p_target: "employee", p_policy: null });
    expect(tableWrites()).toEqual([]);
  });

  test("a guard for another employee is refused before any call", async () => {
    await expect(setEmployeeSchedulingPolicy("00000000-0000-4000-8000-00000000cfff", ORG, null, { contextGuard: schedulingGuard(EMP) })).rejects.toThrow();
    expect(calls.filter((c) => c.kind === "rpc")).toEqual([]);
    expect(tableWrites()).toEqual([]);
  });

  test("no guard → today's update, no RPC", async () => {
    await setOrgSchedulingPolicy(ORG, { policyName: "P", rules: [] } as never);
    expect(casCalls("approver_cas_write_scheduling_policy")).toEqual([]);
    expect(tableWrites().map((c) => c.name)).toEqual(["orgs"]);
  });
});

describe("guard snapshot (production read)", () => {
  const approval = (fingerprint: string | null) => ({
    id: TICKET, orgId: ORG, tool: "policy.patch", status: "approved", requiredApproverKind: "owner",
    approverAuthority: fingerprint === null ? {} : { contextFingerprint: fingerprint },
    metadata: { adminTool: "policy.patch", adminMutation: { employeeId: EMP } },
  }) as never;

  test("reads the judged columns org-scoped and pins them as the expected snapshot", async () => {
    tableResponder = (table) => (table === "employees" ? { data: employeeRow, error: null } : { data: null, error: null });
    const snapshot = await readApproverContextSnapshot(ORG, "policy.patch", { adminMutation: { employeeId: EMP } });
    expect(snapshot).not.toBeNull();
    const read = calls.find((c) => c.kind === "from" && c.name === "employees")!;
    expect(read.opArgs.filter((_, i) => read.ops[i] === "eq")).toEqual([["id", EMP], ["org_id", ORG]]);
    const fingerprint = approverContextFingerprint("policy.patch", snapshot!.context)!;
    const guard = await approverContextGuardForWrite(approval(fingerprint));
    expect(guard).toMatchObject({
      approvalId: TICKET, tool: "policy.patch", fingerprint, employeeId: EMP,
      expected: { scopes: employeeRow.scopes, approval_policy: employeeRow.approval_policy, action_limits: employeeRow.action_limits, tool_approval_defaults: employeeRow.tool_approval_defaults },
    });
  });

  test("2026-10-10 item 2(a): allowed_purposes is read and pinned in the expected snapshot (the RPC compares it under the lock)", async () => {
    tableResponder = (table) => (table === "employees" ? { data: employeeRow, error: null } : { data: null, error: null });
    const snapshot = await readApproverContextSnapshot(ORG, "policy.patch", { adminMutation: { employeeId: EMP } });
    const read = calls.find((c) => c.kind === "from" && c.name === "employees")!;
    const selected = String(read.opArgs[read.ops.indexOf("select")]?.[0] ?? "").split(",").map((c) => c.trim());
    expect(selected).toContain("allowed_purposes");
    expect(snapshot!.expected).toEqual({
      scopes: employeeRow.scopes, allowed_purposes: employeeRow.allowed_purposes, approval_policy: employeeRow.approval_policy,
      action_limits: employeeRow.action_limits, tool_approval_defaults: employeeRow.tool_approval_defaults,
    });
  });

  test("recorded fingerprint differs / missing / row unreadable → approver_context_changed", async () => {
    tableResponder = (table) => (table === "employees" ? { data: employeeRow, error: null } : { data: null, error: null });
    await expect(approverContextGuardForWrite(approval("0".repeat(64)))).rejects.toThrow("approver_context_changed");
    await expect(approverContextGuardForWrite(approval(null))).rejects.toThrow("approver_context_changed");
    tableResponder = () => ({ data: null, error: { message: "read failed" } });
    await expect(approverContextGuardForWrite(approval("0".repeat(64)))).rejects.toThrow("approver_context_changed");
  });

  test("flag OFF → no guard and no read", async () => {
    delete process.env.APPROVER_AUTHORITY_ENABLED;
    expect(await approverContextGuardForWrite(approval("0".repeat(64)))).toBeNull();
    expect(calls).toEqual([]);
  });
});
