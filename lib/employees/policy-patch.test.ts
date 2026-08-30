import { describe, expect, mock, test } from "bun:test";
import { DEMO_ORG } from "../demo-data";

mock.module("@/lib/auth/session", () => ({
  getCurrentOrgId: async () => DEMO_ORG.id,
  getSessionContext: async () => ({
    demo: true,
    userId: null,
    email: "owner@example.com",
    orgId: DEMO_ORG.id,
    member: null,
  }),
}));

mock.module("@/lib/team/demo-actor", () => ({
  requireCapability: async () => ({
    ok: true as const,
    actor: {
      id: "mem_1",
      orgId: DEMO_ORG.id,
      email: "owner@example.com",
      displayName: "山田 太郎",
      role: "owner",
      jobRole: "owner",
      capabilities: ["hire_issue_credentials"],
      status: "active",
    },
  }),
}));

import { PATCH } from "../../app/api/employees/[id]/policy/route";
import { getEmployee, issueEmployee } from "../data/employees";
import type { EmployeeScope } from "../types";
import { POLICY_ERROR_MESSAGES, looksJapanese } from "./policy-errors";

const mixedScopes: EmployeeScope[] = [
  "tools:read",
  "mail:draft",
  "mail:send",
  "commerce:order",
  "approvals:request",
  "audit:append",
];

async function issueMixed() {
  return issueEmployee({
    orgId: DEMO_ORG.id,
    displayName: "上長保存テスト",
    roleLabel: "権限集中",
    scopes: mixedScopes,
    allowedPurposes: ["ops.admin"],
    approvalPolicy: "risk_based",
    sodOverrideAcknowledged: true,
    spend: null,
    allowedAccounts: [],
    secretHash: "hash_policy_patch_test",
    secretPrefix: "gb_emp_ppt",
    expiresAt: null,
    auditSummary: "policy patch sod test",
  });
}

function patchRequest(employeeId: string, body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost/api/employees/${employeeId}/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: employeeId }) }
  );
}

describe("PATCH /api/employees/[id]/policy SoD ack", () => {
  test("unchanged manager patch does not 400 sod_ack", async () => {
    const issued = await issueMixed();
    expect(issued.employee.approvalPolicy).toBe("risk_based");
    const res = await patchRequest(issued.employee.id, {
      scopes: mixedScopes,
      allowedPurposes: ["ops.admin"],
      approvalPolicy: "risk_based",
      actionLimits: issued.employee.actionLimits,
      managerId: "mem_2",
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.employee.managerId).toBe("mem_2");
    expect(body.employee.approvalPolicy).toBe("risk_based");
    const stored = await getEmployee(issued.employee.id, DEMO_ORG.id);
    expect(stored?.approvalPolicy).toBe("risk_based");
    expect(stored?.managerId).toBe("mem_2");
  });

  test("Japanese message on sod_ack when policy actually changes without ack", async () => {
    const issued = await issueMixed();
    const res = await patchRequest(issued.employee.id, {
      scopes: mixedScopes,
      allowedPurposes: ["ops.admin"],
      approvalPolicy: "auto",
      actionLimits: issued.employee.actionLimits,
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("sod_ack_required");
    expect(body.message).toBe(POLICY_ERROR_MESSAGES.sod_ack_required);
    expect(looksJapanese(String(body.message))).toBe(true);
  });
});

const sendConfirmScopes: EmployeeScope[] = [
  "tools:read",
  "mail:send",
  "calendar:confirm",
  "slack:post",
  "approvals:request",
  "audit:append",
];

describe("PATCH send+confirm warn requires ack and keeps risk_based", () => {
  test("changing to send+confirm without ack is 400; with ack keeps risk_based", async () => {
    const issued = await issueEmployee({
      orgId: DEMO_ORG.id,
      displayName: "同居パッチ",
      roleLabel: "秘書",
      scopes: ["tools:read", "slack:post", "approvals:request", "audit:append"],
      allowedPurposes: ["ops.admin"],
      approvalPolicy: "risk_based",
      spend: null,
      allowedAccounts: [],
      secretHash: "hash_send_confirm_patch",
      secretPrefix: "gb_emp_scp",
      expiresAt: null,
      auditSummary: "send confirm patch",
    });
    const denied = await patchRequest(issued.employee.id, {
      scopes: sendConfirmScopes,
      allowedPurposes: ["ops.admin"],
      approvalPolicy: "risk_based",
      actionLimits: {},
    });
    const deniedBody = await denied.json();
    expect(denied.status).toBe(400);
    expect(deniedBody.error).toBe("sod_ack_required");

    const allowed = await patchRequest(issued.employee.id, {
      scopes: sendConfirmScopes,
      allowedPurposes: ["ops.admin"],
      approvalPolicy: "risk_based",
      actionLimits: {},
      sodOverrideAcknowledged: true,
    });
    const allowedBody = await allowed.json();
    expect(allowed.status).toBe(200);
    expect(allowedBody.employee.approvalPolicy).toBe("risk_based");
    expect(allowedBody.employee.sodLevel).toBe("warn");
  });
});
