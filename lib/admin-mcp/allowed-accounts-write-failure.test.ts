/**
 * fulfillAllowedAccountsChange must not report success when the storage write
 * throws (updateEmployeeAllowedAccounts is fail-closed): ok:false with
 * allowed_accounts_update_failed, a `.rejected` audit row, and no
 * `.added` / `.removed` audit row. Demo mode; only the write is faked.
 */
import { describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";

let failWrite = false;
const realEmployees = { ...(await import("@/lib/data/employees")) };
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/data/employees", {
  updateEmployeeAllowedAccounts: async (input: Parameters<typeof realEmployees.updateEmployeeAllowedAccounts>[0]) => {
    if (failWrite) {
      const error = new Error("credentials_boom") as Error & { code: string; rolledBack: boolean };
      error.code = "allowed_accounts_credentials_update_failed";
      error.rolledBack = true;
      throw error;
    }
    return realEmployees.updateEmployeeAllowedAccounts(input);
  },
});

const { ALLOWED_ACCOUNTS_TOOLS_FLAG, fulfillAllowedAccountsChange } = await import("@/lib/admin-mcp/allowed-accounts-tools");
const { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } = await import("@/lib/demo-data");
type ApprovalRequest = import("@/lib/types").ApprovalRequest;
type Employee = import("@/lib/types").Employee;

function newEmployee(): Employee {
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const employee: Employee = {
    ...base,
    id: `emp_aa_wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    orgId: DEMO_ORG.id,
    status: "active",
    scopes: ["slack:post"] as Employee["scopes"],
    allowedAccounts: [{ service: "google", accountId: "sales@example.co.jp", browserRequired: true }],
  };
  getRuntimeEmployees().push(employee);
  return employee;
}

function approval(id: string): ApprovalRequest {
  return {
    id,
    orgId: DEMO_ORG.id,
    resolvedBy: "owner@example.com",
    metadata: { adminRequester: { kind: "admin_agent", actorId: "adm_wf", grokBotAgentId: "grok_wf_other" } },
  } as unknown as ApprovalRequest;
}

describe("fulfillment when the write fails", () => {
  test("add: write throws → ok:false allowed_accounts_update_failed, rejected audit, nothing claimed", async () => {
    const saved = process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG];
    process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG] = "true";
    failWrite = true;
    try {
      const emp = newEmployee();
      const id = `apr_wf_${Date.now().toString(36)}`;
      const result = await fulfillAllowedAccountsChange(approval(id), "employees.allowedAccounts.add", {
        employeeId: emp.id,
        provider: "slack",
        accountId: "U0C1RN0AHE1",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("allowed_accounts_update_failed");
        expect(result.messageJa).toContain("できませんでした");
        expect(result.messageJa).toContain("変更していません");
      }
      const rows = getRuntimeAudit().filter((e) => e.metadata?.approvalId === id);
      expect(rows.some((e) => e.metadata?.event === "employee.allowed_accounts.rejected" && e.metadata?.code === "allowed_accounts_update_failed")).toBe(true);
      expect(rows.some((e) => e.metadata?.event === "employee.allowed_accounts.added")).toBe(false);
    } finally {
      failWrite = false;
      if (saved === undefined) delete process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG];
      else process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG] = saved;
    }
  });
});
