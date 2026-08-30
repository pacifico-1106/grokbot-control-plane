import { describe, expect, test } from "bun:test";
import { DEMO_ORG } from "../demo-data";
import { issueEmployee, updateEmployeePolicy } from "./employees";
import type { EmployeeScope } from "../types";

const mixedScopes: EmployeeScope[] = [
  "tools:read",
  "mail:draft",
  "mail:send",
  "commerce:order",
  "approvals:request",
  "audit:append",
];

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    orgId: DEMO_ORG.id,
    displayName: "安藤テスト",
    roleLabel: "権限集中",
    scopes: mixedScopes,
    allowedPurposes: ["ops.admin"],
    approvalPolicy: "risk_based" as const,
    spend: null,
    allowedAccounts: [],
    secretHash: "hash_sod_override_test",
    secretPrefix: "gb_emp_sod",
    expiresAt: null,
    auditSummary: "SoD override test issue",
    ...overrides,
  };
}

describe("issueEmployee SoD acknowledgment", () => {
  test("without ack still forces always_human", async () => {
    const result = await issueEmployee(issueInput());
    expect(result.employee.sodLevel).toBe("force_human");
    expect(result.employee.approvalPolicy).toBe("always_human");
  });

  test("with ack keeps requested risk_based", async () => {
    const result = await issueEmployee(
      issueInput({ sodOverrideAcknowledged: true, displayName: "安藤承諾" })
    );
    expect(result.employee.sodLevel).toBe("force_human");
    expect(result.employee.approvalPolicy).toBe("risk_based");
  });
});

describe("updateEmployeePolicy SoD acknowledgment", () => {
  test("without ack re-locks to always_human; with ack keeps requested", async () => {
    const issued = await issueEmployee(
      issueInput({ sodOverrideAcknowledged: true, displayName: "安藤更新" })
    );
    expect(issued.employee.approvalPolicy).toBe("risk_based");

    const locked = await updateEmployeePolicy({
      orgId: DEMO_ORG.id,
      employeeId: issued.employee.id,
      scopes: mixedScopes,
      allowedPurposes: ["ops.admin"],
      approvalPolicy: "auto",
    });
    expect(locked?.sodLevel).toBe("force_human");
    expect(locked?.approvalPolicy).toBe("always_human");

    const allowed = await updateEmployeePolicy({
      orgId: DEMO_ORG.id,
      employeeId: issued.employee.id,
      scopes: mixedScopes,
      allowedPurposes: ["ops.admin"],
      approvalPolicy: "risk_based",
      sodOverrideAcknowledged: true,
    });
    expect(allowed?.sodLevel).toBe("force_human");
    expect(allowed?.approvalPolicy).toBe("risk_based");
  });
});

const sendConfirmScopes: EmployeeScope[] = [
  "tools:read",
  "mail:draft",
  "mail:send",
  "calendar:confirm",
  "slack:post",
  "approvals:request",
  "audit:append",
];

describe("issueEmployee send+confirm warn", () => {
  test("without ack keeps requested risk_based (does not rewrite always_human)", async () => {
    const result = await issueEmployee(
      issueInput({
        displayName: "安藤同居",
        scopes: sendConfirmScopes,
      })
    );
    expect(result.employee.sodLevel).toBe("warn");
    expect(result.employee.approvalPolicy).toBe("risk_based");
    expect(result.employee.toolApprovalDefaults?.["mail.send"]).toBe("always_human");
    expect(result.employee.toolApprovalDefaults?.["calendar.confirm"]).toBe("always_human");
  });

  test("with ack keeps requested risk_based", async () => {
    const result = await issueEmployee(
      issueInput({
        displayName: "安藤承諾同居",
        scopes: sendConfirmScopes,
        sodOverrideAcknowledged: true,
      })
    );
    expect(result.employee.sodLevel).toBe("warn");
    expect(result.employee.approvalPolicy).toBe("risk_based");
  });
});
