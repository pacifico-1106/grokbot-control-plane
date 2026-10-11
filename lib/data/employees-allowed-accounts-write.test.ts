/**
 * updateEmployeeAllowedAccounts (Supabase path) must be fail-closed:
 * a failed write to employees OR to the active credentials row is never
 * reported as success. When the credentials write fails after employees was
 * written, employees.allowed_accounts is put back to the previous value
 * (no half-applied state), then the error is thrown.
 */
import { describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";

type Op = { table: string; kind: "select" | "update"; values?: Record<string, unknown>; filters: Array<[string, string, unknown]> };

const ORG = "org_write_test";
const EMP = "emp_write_test";
const PREVIOUS = [{ service: "slack", accountId: "U0PREVIOUS1" }];
const NEXT = [{ service: "slack", accountId: "U0NEXTVALU1" }];

const state: {
  ops: Op[];
  failCredentials: boolean;
  failEmployeesUpdate: boolean;
  employeeExists: boolean;
  employeeRow: Record<string, unknown>;
} = {
  ops: [],
  failCredentials: false,
  failEmployeesUpdate: false,
  employeeExists: true,
  employeeRow: {},
};

function reset() {
  state.ops = [];
  state.failCredentials = false;
  state.failEmployeesUpdate = false;
  state.employeeExists = true;
  state.employeeRow = {
    id: EMP,
    org_id: ORG,
    display_name: "稲盛",
    role_label: "営業",
    status: "active",
    scopes: ["slack:post"],
    allowed_purposes: [],
    approval_policy: "always_human",
    allowed_accounts: PREVIOUS,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

function builder(table: string) {
  const op: Op = { table, kind: "select", filters: [] };
  const run = (): { data: unknown; error: unknown } => {
    state.ops.push(op);
    if (table === "credentials" && op.kind === "update") {
      return state.failCredentials ? { data: null, error: { message: "credentials_boom" } } : { data: null, error: null };
    }
    if (table === "employees") {
      if (!state.employeeExists) return { data: null, error: null };
      if (op.kind === "update") {
        if (state.failEmployeesUpdate) return { data: null, error: { message: "employees_boom" } };
        state.employeeRow = { ...state.employeeRow, ...(op.values ?? {}) };
      }
      return { data: { ...state.employeeRow }, error: null };
    }
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

const { updateEmployeeAllowedAccounts } = await import("@/lib/data/employees");

const employeeUpdates = () => state.ops.filter((o) => o.table === "employees" && o.kind === "update");
const credentialUpdates = () => state.ops.filter((o) => o.table === "credentials" && o.kind === "update");

describe("updateEmployeeAllowedAccounts (Supabase) is fail-closed", () => {
  test("success: employees and active credentials both written, org-scoped", async () => {
    reset();
    const updated = await updateEmployeeAllowedAccounts({ orgId: ORG, employeeId: EMP, allowedAccounts: NEXT });
    expect(updated?.allowedAccounts).toEqual(NEXT);
    expect(employeeUpdates()).toHaveLength(1);
    expect(credentialUpdates()).toHaveLength(1);
    expect(credentialUpdates()[0].values).toEqual({ allowed_accounts: NEXT });
    expect(credentialUpdates()[0].filters).toEqual([
      ["eq", "employee_id", EMP],
      ["eq", "org_id", ORG],
      ["is", "revoked_at", null],
    ]);
  });

  test("credentials update error → throws (never success) and employees is restored to the previous accounts", async () => {
    reset();
    state.failCredentials = true;
    let caught: unknown = null;
    try {
      await updateEmployeeAllowedAccounts({ orgId: ORG, employeeId: EMP, allowedAccounts: NEXT });
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof Error).toBe(true);
    expect((caught as { code?: string }).code).toBe("allowed_accounts_credentials_update_failed");
    expect((caught as { rolledBack?: boolean }).rolledBack).toBe(true);
    const writes = employeeUpdates();
    expect(writes.at(-1)?.values?.allowed_accounts).toEqual(PREVIOUS);
    expect(
      (writes.at(-1)?.filters ?? []).some((f) => JSON.stringify(f) === JSON.stringify(["eq", "org_id", ORG])),
    ).toBe(true);
    expect(state.employeeRow.allowed_accounts).toEqual(PREVIOUS);
  });

  test("employees update error → throws (not reported as 'not found')", async () => {
    reset();
    state.failEmployeesUpdate = true;
    let caught: unknown = null;
    try {
      await updateEmployeeAllowedAccounts({ orgId: ORG, employeeId: EMP, allowedAccounts: NEXT });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("allowed_accounts_update_failed");
    expect(credentialUpdates()).toHaveLength(0);
  });

  test("employee not in the org → null, nothing written to credentials", async () => {
    reset();
    state.employeeExists = false;
    expect(await updateEmployeeAllowedAccounts({ orgId: ORG, employeeId: EMP, allowedAccounts: NEXT })).toBeNull();
    expect(credentialUpdates()).toHaveLength(0);
  });
});
