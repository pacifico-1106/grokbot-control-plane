/**
 * updateEmployeePolicy (Supabase path) must be fail-closed, same shape as
 * updateEmployeeAllowedAccounts (#242):
 * - a failed write to the active credentials row is never reported as
 *   success: the employees columns that were just written are put back to
 *   their previous values, then an error with a code (and whether the
 *   restore worked) is thrown;
 * - an employees read / update error is thrown, never reported as
 *   "employee not found" (null).
 */
import { describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";

type Op = { table: string; kind: "select" | "update"; values?: Record<string, unknown>; filters: Array<[string, string, unknown]> };

const ORG = "org_policy_write_test";
const EMP = "emp_policy_write_test";
const PREVIOUS_ACCOUNTS = [{ service: "slack", accountId: "U0PREVIOUS1" }];
const NEXT_ACCOUNTS = [{ service: "slack", accountId: "U0NEXTVALU1" }];

const state: {
  ops: Op[];
  failRead: boolean;
  failEmployeesUpdate: boolean;
  failCredentials: boolean;
  failRollback: boolean;
  employeeExists: boolean;
  employeeRow: Record<string, unknown>;
} = {
  ops: [],
  failRead: false,
  failEmployeesUpdate: false,
  failCredentials: false,
  failRollback: false,
  employeeExists: true,
  employeeRow: {},
};

const PREVIOUS_ROW: Record<string, unknown> = {
  id: EMP,
  org_id: ORG,
  display_name: "稲盛",
  role_label: "営業",
  status: "active",
  scopes: ["slack:post"],
  allowed_purposes: ["sales.followup"],
  approval_policy: "always_human",
  tool_approval_defaults: null,
  sod_level: "ok",
  action_limits: {},
  allowed_accounts: PREVIOUS_ACCOUNTS,
  spend: null,
  manager_id: null,
  posting_as: "bot",
  approval_channel_id: null,
  approver_user_ids: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

function reset() {
  state.ops = [];
  state.failRead = false;
  state.failEmployeesUpdate = false;
  state.failCredentials = false;
  state.failRollback = false;
  state.employeeExists = true;
  state.employeeRow = structuredClone(PREVIOUS_ROW);
}

function builder(table: string) {
  const op: Op = { table, kind: "select", filters: [] };
  const run = (): { data: unknown; error: unknown } => {
    state.ops.push(op);
    if (table === "credentials" && op.kind === "update") {
      return state.failCredentials ? { data: null, error: { message: "credentials_boom" } } : { data: null, error: null };
    }
    if (table === "employees") {
      if (op.kind === "select") {
        if (state.failRead) return { data: null, error: { message: "employees_read_boom" } };
        if (!state.employeeExists) return { data: null, error: null };
        return { data: { ...state.employeeRow }, error: null };
      }
      const priorUpdates = state.ops.filter((o) => o.table === "employees" && o.kind === "update").length - 1;
      if (priorUpdates === 0 && state.failEmployeesUpdate) return { data: null, error: { message: "employees_boom" } };
      if (priorUpdates > 0 && state.failRollback) return { data: null, error: { message: "rollback_boom" } };
      if (!state.employeeExists) return { data: null, error: null };
      state.employeeRow = { ...state.employeeRow, ...(op.values ?? {}) };
      return { data: { ...state.employeeRow }, error: null };
    }
    // orgs (SoD warn policy) and anything else: no row.
    return { data: null, error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    update: (values: Record<string, unknown>) => {
      op.kind = "update";
      op.values = values;
      return b;
    },
    eq: (col: string, val: unknown) => {
      op.filters.push(["eq", col, val]);
      return b;
    },
    is: (col: string, val: unknown) => {
      op.filters.push(["is", col, val]);
      return b;
    },
    maybeSingle: async () => run(),
    single: async () => run(),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
  };
  return b;
}

const mocks = scopedModuleMocks();
await mocks.mock("@/lib/mode", { isDemoMode: () => false });
await mocks.mock("@/lib/supabase", { createSupabaseAdminClient: () => ({ from: (table: string) => builder(table) }) });

const { updateEmployeePolicy } = await import("@/lib/data/employees");

const INPUT = {
  orgId: ORG,
  employeeId: EMP,
  scopes: ["slack:post", "mail:draft"] as never,
  allowedPurposes: ["sales.followup", "ops.report"],
  approvalPolicy: "risk_based" as const,
  allowedAccounts: NEXT_ACCOUNTS as never,
  displayName: "稲盛（新）",
};

const employeeReads = () => state.ops.filter((o) => o.table === "employees" && o.kind === "select");
const employeeUpdates = () => state.ops.filter((o) => o.table === "employees" && o.kind === "update");
const credentialUpdates = () => state.ops.filter((o) => o.table === "credentials" && o.kind === "update");
const hasFilter = (op: Op | undefined, f: [string, string, unknown]) =>
  (op?.filters ?? []).some((x) => JSON.stringify(x) === JSON.stringify(f));

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("updateEmployeePolicy (Supabase) is fail-closed", () => {
  test("success: employees and active credentials both written, org-scoped (unchanged behaviour)", async () => {
    reset();
    const updated = await updateEmployeePolicy(INPUT);
    expect(updated?.displayName).toBe("稲盛（新）");
    expect(updated?.allowedAccounts).toEqual(NEXT_ACCOUNTS);
    expect(employeeUpdates()).toHaveLength(1);
    expect(hasFilter(employeeUpdates()[0], ["eq", "org_id", ORG])).toBe(true);
    expect(credentialUpdates()).toHaveLength(1);
    expect(credentialUpdates()[0].values).toEqual({
      scopes: ["slack:post", "mail:draft"],
      allowed_purposes: ["sales.followup", "ops.report"],
      approval_policy: "risk_based",
      action_limits: (employeeUpdates()[0].values ?? {}).action_limits,
      allowed_accounts: NEXT_ACCOUNTS,
    });
    expect(credentialUpdates()[0].filters).toEqual([
      ["eq", "employee_id", EMP],
      ["eq", "org_id", ORG],
      ["is", "revoked_at", null],
    ]);
  });

  test("credentials update error → throws with a code (never success) and employees is restored to the previous values", async () => {
    reset();
    state.failCredentials = true;
    const error = await caught(() => updateEmployeePolicy(INPUT));
    expect(error instanceof Error).toBe(true);
    expect((error as { code?: string }).code).toBe("employee_policy_credentials_update_failed");
    expect((error as { rolledBack?: boolean }).rolledBack).toBe(true);

    const writes = employeeUpdates();
    expect(writes).toHaveLength(2);
    const written = Object.keys(writes[0].values ?? {}).filter((k) => k !== "updated_at");
    const restore = writes[1].values ?? {};
    // Every column that was written is put back to exactly its previous value…
    for (const key of written) expect(restore[key]).toEqual(PREVIOUS_ROW[key]);
    // …and nothing else is touched by the restore.
    expect(Object.keys(restore).filter((k) => k !== "updated_at").sort()).toEqual([...written].sort());
    expect(hasFilter(writes[1], ["eq", "id", EMP])).toBe(true);
    expect(hasFilter(writes[1], ["eq", "org_id", ORG])).toBe(true);
    for (const key of written) expect(state.employeeRow[key]).toEqual(PREVIOUS_ROW[key]);
  });

  test("credentials update error AND restore error → throws with rolledBack:false", async () => {
    reset();
    state.failCredentials = true;
    state.failRollback = true;
    const error = await caught(() => updateEmployeePolicy(INPUT));
    expect((error as { code?: string }).code).toBe("employee_policy_credentials_update_failed");
    expect((error as { rolledBack?: boolean }).rolledBack).toBe(false);
    expect(employeeUpdates()).toHaveLength(2);
  });

  test("employees read error → throws (not reported as 'not found'), nothing written", async () => {
    reset();
    state.failRead = true;
    const error = await caught(() => updateEmployeePolicy(INPUT));
    expect((error as { code?: string }).code).toBe("employee_policy_update_failed");
    expect(employeeReads().length).toBeGreaterThan(0);
    expect(employeeUpdates()).toHaveLength(0);
    expect(credentialUpdates()).toHaveLength(0);
  });

  test("employees update error → throws (not reported as 'not found'), credentials not written", async () => {
    reset();
    state.failEmployeesUpdate = true;
    const error = await caught(() => updateEmployeePolicy(INPUT));
    expect((error as { code?: string }).code).toBe("employee_policy_update_failed");
    expect(credentialUpdates()).toHaveLength(0);
  });

  test("employee not in the org → null, nothing written", async () => {
    reset();
    state.employeeExists = false;
    expect(await updateEmployeePolicy(INPUT)).toBeNull();
    expect(employeeUpdates().length).toBeLessThanOrEqual(1);
    expect(credentialUpdates()).toHaveLength(0);
  });

  test("the previous-value read is org-scoped", async () => {
    reset();
    await updateEmployeePolicy(INPUT);
    const read = employeeReads()[0];
    expect(hasFilter(read, ["eq", "id", EMP])).toBe(true);
    expect(hasFilter(read, ["eq", "org_id", ORG])).toBe(true);
  });
});

describe("updateEmployeePolicy (Supabase): omitted allowedPurposes / actionLimits keep the stored value (木村 2026-10-05)", () => {
  const PARTIAL = { orgId: ORG, employeeId: EMP, scopes: ["slack:post"] as never, approvalPolicy: "always_human" as const };
  test("omitted → neither employees nor credentials gets allowed_purposes / action_limits", async () => {
    reset();
    state.employeeRow = { ...state.employeeRow, action_limits: { "slack.post": { perDay: 3 } } };
    await updateEmployeePolicy(PARTIAL as never);
    for (const op of [...employeeUpdates(), ...credentialUpdates()]) {
      expect([op.table, "allowed_purposes" in (op.values ?? {}), "action_limits" in (op.values ?? {})]).toEqual([op.table, false, false]);
    }
    expect(state.employeeRow.allowed_purposes).toEqual(["sales.followup"]);
    expect(state.employeeRow.action_limits).toEqual({ "slack.post": { perDay: 3 } });
  });
  test("explicit [] / {} → both written (clearing is explicit)", async () => {
    reset();
    await updateEmployeePolicy({ ...PARTIAL, allowedPurposes: [], actionLimits: {} } as never);
    expect(employeeUpdates()[0].values).toMatchObject({ allowed_purposes: [], action_limits: {} });
    expect(credentialUpdates()[0].values).toMatchObject({ allowed_purposes: [], action_limits: {} });
  });
});
