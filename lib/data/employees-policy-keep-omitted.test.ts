/**
 * 木村 2026-10-10 (production data loss): updateEmployeePolicy called WITHOUT
 * actionLimits (e.g. setup.lineApproval.setEmployeeInbox fulfilment, since
 * 30a631f) wrote action_limits = {} to employees AND the active credentials
 * row — every per-tool cap (incl. commerce.order) was wiped.
 *
 * Supabase path: an omitted field is left out of BOTH patches (the stored value
 * stays); an explicit {} still clears; an explicit value is written. Both writes
 * stay org-scoped.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";

type Op = { table: string; kind: "select" | "update"; values?: Record<string, unknown>; filters: Array<[string, string, unknown]> };

const ORG = "org_policy_keep_test";
const EMP = "emp_policy_keep_test";
const LIMITS = { "commerce.order": { perDay: 3, perMonth: 20 }, "mail.send": { perDay: 50 } };
const TOOL_DEFAULTS = { "mail.send": "always_human" };

const state: { ops: Op[]; employeeRow: Record<string, unknown>; credentialsRow: Record<string, unknown> } = {
  ops: [],
  employeeRow: {},
  credentialsRow: {},
};

const ROW: Record<string, unknown> = {
  id: EMP,
  org_id: ORG,
  display_name: "稲盛",
  role_label: "営業",
  status: "active",
  scopes: ["slack:post", "commerce:order"],
  allowed_purposes: ["sales.followup"],
  approval_policy: "risk_based",
  tool_approval_defaults: TOOL_DEFAULTS,
  sod_level: "ok",
  action_limits: LIMITS,
  allowed_accounts: [],
  spend: { maxPerOrderJpy: 5000 },
  manager_id: null,
  posting_as: "bot",
  approval_channel_id: null,
  approver_user_ids: ["U0APPROVER1"],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  state.ops = [];
  state.employeeRow = structuredClone(ROW);
  state.credentialsRow = { action_limits: structuredClone(LIMITS), spend: { maxPerOrderJpy: 5000 } };
});

function builder(table: string) {
  const op: Op = { table, kind: "select", filters: [] };
  const run = (): { data: unknown; error: unknown } => {
    state.ops.push(op);
    if (table === "credentials" && op.kind === "update") {
      state.credentialsRow = { ...state.credentialsRow, ...(op.values ?? {}) };
      return { data: null, error: null };
    }
    if (table === "employees") {
      if (op.kind === "select") return { data: { ...state.employeeRow }, error: null };
      state.employeeRow = { ...state.employeeRow, ...(op.values ?? {}) };
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

const { updateEmployeePolicy } = await import("@/lib/data/employees");

/** What fulfillLineApprovalSetEmployeeInbox sends: the current required fields + the inbox only. */
const LINE_INBOX_INPUT = {
  orgId: ORG,
  employeeId: EMP,
  scopes: ["slack:post", "commerce:order"] as never,
  allowedPurposes: ["sales.followup"],
  approvalPolicy: "risk_based" as const,
  approvalChannelId: "nch_line_1",
};

const employeeUpdate = () => state.ops.find((o) => o.table === "employees" && o.kind === "update");
const credentialUpdate = () => state.ops.find((o) => o.table === "credentials" && o.kind === "update");
const has = (op: Op | undefined, f: [string, string, unknown]) =>
  (op?.filters ?? []).some((x) => JSON.stringify(x) === JSON.stringify(f));

describe("updateEmployeePolicy (Supabase): an omitted field keeps the stored value", () => {
  test("LINE inbox shape (no actionLimits): action_limits not in the employees patch NOR the credentials patch; stored caps survive", async () => {
    const updated = await updateEmployeePolicy(LINE_INBOX_INPUT);
    expect(updated).not.toBeNull();
    expect(Object.keys(employeeUpdate()?.values ?? {})).not.toContain("action_limits");
    expect(Object.keys(credentialUpdate()?.values ?? {})).not.toContain("action_limits");
    expect(state.employeeRow.action_limits).toEqual(LIMITS);
    expect(state.credentialsRow.action_limits).toEqual(LIMITS);
    expect(updated?.actionLimits).toEqual(LIMITS);
    expect(state.employeeRow.approval_channel_id).toBe("nch_line_1");
  });

  test("LINE inbox shape also keeps tool_approval_defaults / spend / approver_user_ids / allowed_accounts", async () => {
    await updateEmployeePolicy(LINE_INBOX_INPUT);
    for (const column of ["tool_approval_defaults", "spend", "approver_user_ids", "allowed_accounts"]) {
      expect(Object.keys(employeeUpdate()?.values ?? {})).not.toContain(column);
    }
    expect(Object.keys(credentialUpdate()?.values ?? {})).not.toContain("spend");
    expect(state.employeeRow.tool_approval_defaults).toEqual(TOOL_DEFAULTS);
    expect(state.employeeRow.spend).toEqual({ maxPerOrderJpy: 5000 });
    expect(state.employeeRow.approver_user_ids).toEqual(["U0APPROVER1"]);
  });

  test("explicit {} still clears both rows (an intended clear is not blocked)", async () => {
    await updateEmployeePolicy({ ...LINE_INBOX_INPUT, actionLimits: {} });
    expect(employeeUpdate()?.values?.action_limits).toEqual({});
    expect(credentialUpdate()?.values?.action_limits).toEqual({});
    expect(state.employeeRow.action_limits).toEqual({});
    expect(state.credentialsRow.action_limits).toEqual({});
  });

  test("explicit value is normalized and written to both rows", async () => {
    await updateEmployeePolicy({ ...LINE_INBOX_INPUT, actionLimits: { "commerce.order": { perDay: 1, perMonth: 0 } } as never });
    expect(state.employeeRow.action_limits).toEqual({ "commerce.order": { perDay: 1 } });
    expect(state.credentialsRow.action_limits).toEqual({ "commerce.order": { perDay: 1 } });
  });

  test("org scoping (BOLA unchanged): employees read / update and the credentials update are all filtered by org_id + id", async () => {
    await updateEmployeePolicy(LINE_INBOX_INPUT);
    for (const op of state.ops.filter((o) => o.table === "employees")) {
      expect(has(op, ["eq", "org_id", ORG])).toBe(true);
      expect(has(op, ["eq", "id", EMP])).toBe(true);
    }
    expect(has(credentialUpdate(), ["eq", "org_id", ORG])).toBe(true);
    expect(has(credentialUpdate(), ["eq", "employee_id", EMP])).toBe(true);
    expect(has(credentialUpdate(), ["is", "revoked_at", null])).toBe(true);
  });
});
