/**
 * PR-2: approvalRoutes.patch / decision.deputy* / credential.renew_*
 * become admin.* events when the six-field flag is ON. Flag OFF keeps
 * today's action names.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees, pushRuntimeApproval } from "@/lib/demo-data";
import { recordCredentialAutoRenewFiling, fulfillCredentialAutoRenew } from "@/lib/employees/credential-auto-renew";
import {
  demoResetCredentialRenewals,
} from "@/lib/data/credential-renewals";
import type { ApprovalRequest } from "@/lib/types";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const FLAG = "ADMIN_AUDIT_SIX_FIELD_WRITE_ENABLED";
const ORGS = "ADMIN_AUDIT_SIX_FIELD_WRITE_ORG_IDS";
const KIND = "P1_APPROVAL_KIND_ROUTES_ENABLED";
const DECISION = "P1_DECISION_WORKFLOW_ENABLED";
const APPROVER_EMAIL = "web:approver@example.com";
const MASKED_APPROVER = "a***@example.com";
const ENV_KEYS = [FLAG, ORGS, KIND, DECISION] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  demoResetCredentialRenewals();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  demoResetCredentialRenewals();
});

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "apr_six_field_1",
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    title: "six-field fixture",
    purpose: "admin.policy",
    summary: "six-field fixture",
    risk: "medium",
    status: "approved",
    tool: "employees.credential.auto_renew",
    jobId: "job_six_field_1",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: null,
    telegramMessageId: null,
    metadata: {},
    statusToken: "token_six_field_1",
    pollPath: "/api/approvals/status?id=apr_six_field_1&token=token_six_field_1",
    createdAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    resolvedBy: APPROVER_EMAIL,
    ...overrides,
  };
}

function mockAdminCred(): ResolvedAdminCredential {
  return {
    orgId: DEMO_ORG.id,
    adminAgentId: "adm_six_field",
    grokBotAgentId: null,
    actorId: "actor_six_field",
    generation: 1,
    via: "bearer",
    agent: {
      id: "adm_six_field",
      orgId: DEMO_ORG.id,
      grokBotAgentId: null,
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      secretPrefix: "gb_adm_test",
      credentialGeneration: 1,
      status: "linked",
      opsDocLocation: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

describe("admin.* class events (six-field)", () => {
  test("flag OFF: credential.renew_proposed keeps the legacy action (regression)", async () => {
    const emp = getRuntimeEmployees().find((e) => e.orgId === DEMO_ORG.id);
    expect(emp).toBeTruthy();
    const recorded = await recordCredentialAutoRenewFiling({
      orgId: DEMO_ORG.id,
      employeeId: emp!.id,
      oldCredentialId: emp!.credentialId || "cred_six_off",
      approvalId: "apr_renew_off",
      source: "admin_mcp",
    });
    expect(recorded.ok).toBe(true);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === "apr_renew_off");
    expect(row).toBeTruthy();
    expect(row!.action).toBe("credential.renew_proposed");
    expect(row!.metadata?.target).toBeUndefined();
    expect(row!.metadata?.result).toBeUndefined();
  });

  test("flag ON: credential.renew_proposed is written as admin.credential.renew_proposed with six fields", async () => {
    process.env[FLAG] = "true";
    const emp = getRuntimeEmployees().find((e) => e.orgId === DEMO_ORG.id);
    expect(emp).toBeTruthy();
    const recorded = await recordCredentialAutoRenewFiling({
      orgId: DEMO_ORG.id,
      employeeId: emp!.id,
      oldCredentialId: emp!.credentialId || "cred_six_on",
      approvalId: "apr_renew_on",
      source: "admin_mcp",
    });
    expect(recorded.ok).toBe(true);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === "apr_renew_on");
    expect(row).toBeTruthy();
    expect(row!.action).toBe("admin.credential.renew_proposed");
    expect(row!.metadata?.target).toEqual({ type: "employee", id: emp!.id });
    const reason = row!.metadata?.reason as { code?: string; labelJa?: string };
    expect(reason.code).toBeTruthy();
    expect(reason.labelJa).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
    expect(row!.metadata?.result).toBe("pending");
    expect(JSON.stringify(row!.metadata)).not.toMatch(/gb_emp_|claim_token|oneTimeSecret/);
  });

  test("flag ON: helper maps approvalRoutes / deputy / renew aliases to admin.*", async () => {
    process.env[FLAG] = "true";
    const { adminSixFieldAction } = await import("@/lib/audit/admin-audit");
    expect(adminSixFieldAction(DEMO_ORG.id, "approval_routes.patch", "admin.approvalRoutes.patch")).toBe(
      "admin.approvalRoutes.patch"
    );
    expect(adminSixFieldAction(DEMO_ORG.id, "decision.deputy_activated", "admin.decision.deputy_activated")).toBe(
      "admin.decision.deputy_activated"
    );
    expect(adminSixFieldAction(DEMO_ORG.id, "decision.deputy_activated", "admin.decision.deputyActivate")).toBe(
      "admin.decision.deputyActivate"
    );
    expect(adminSixFieldAction(DEMO_ORG.id, "credential.renew_approved", "admin.credential.renew_approved")).toBe(
      "admin.credential.renew_approved"
    );
  });

  test("flag OFF: helper keeps legacy action names", async () => {
    const { adminSixFieldAction } = await import("@/lib/audit/admin-audit");
    expect(adminSixFieldAction(DEMO_ORG.id, "approval_routes.patch", "admin.approvalRoutes.patch")).toBe(
      "approval_routes.patch"
    );
    expect(adminSixFieldAction(DEMO_ORG.id, "credential.renew_proposed", "admin.credential.renew_proposed")).toBe(
      "credential.renew_proposed"
    );
  });
});

describe("L2: mask approvedBy / approver email when six-field is ON", () => {
  test("flag OFF: credential.renew_rejected keeps raw approver email (regression)", async () => {
    const approval = makeApproval({ id: "apr_renew_approver_off" });
    const result = await fulfillCredentialAutoRenew(approval, { employeeId: "emp_sales" });
    expect(result.ok).toBe(false);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === approval.id);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("credential.renew_rejected");
    expect(row!.metadata?.approver).toBe(APPROVER_EMAIL);
    expect(JSON.stringify(row!.metadata)).toContain("approver@example.com");
  });

  test("flag ON: credential.renew_rejected masks approver email", async () => {
    process.env[FLAG] = "true";
    const approval = makeApproval({ id: "apr_renew_approver_on" });
    const result = await fulfillCredentialAutoRenew(approval, { employeeId: "emp_sales" });
    expect(result.ok).toBe(false);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === approval.id);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("admin.credential.renew_rejected");
    expect(row!.metadata?.approver).toBe(MASKED_APPROVER);
    expect(JSON.stringify(row!.metadata)).not.toContain("approver@example.com");
    expect(JSON.stringify(row!.metadata)).not.toContain(APPROVER_EMAIL);
  });

  test("flag OFF: approvalRoutes.patch keeps raw approvedBy email (regression)", async () => {
    process.env[KIND] = "true";
    const { resetDemoApprovalKindRoutesData } = await import("@/lib/approval-kind-routes/data");
    const { fulfillApprovalRoutesPatch } = await import("@/lib/approval-kind-routes/mcp-handlers");
    resetDemoApprovalKindRoutesData();
    const approval = makeApproval({
      id: "apr_routes_approvedby_off",
      tool: "approvalRoutes.patch",
      metadata: {
        argsSnapshot: {
          beforeSnapshot: null,
          afterSnapshot: {
            version: 1,
            policyId: "akr_off",
            policyName: "テスト",
            routes: [
              {
                kind: "post",
                approverUserIds: ["user-1"],
                quorum: { type: "any" },
                finalGoUserId: null,
                deadlineHours: null,
                onExpire: "fail_closed",
                remindEveryDays: 3,
              },
            ],
            updatedAt: new Date().toISOString(),
            updatedBy: "test",
          },
          diffSummary: ["新規ポリシーを作成します"],
        },
      },
    });
    const result = await fulfillApprovalRoutesPatch(approval, {});
    expect(result.ok).toBe(true);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === approval.id);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("approval_routes.patch");
    expect(row!.metadata?.approvedBy).toBe(APPROVER_EMAIL);
    expect(JSON.stringify(row!.metadata)).toContain("approver@example.com");
    resetDemoApprovalKindRoutesData();
  });

  test("flag ON: approvalRoutes.patch masks approvedBy email", async () => {
    process.env[FLAG] = "true";
    process.env[KIND] = "true";
    const { resetDemoApprovalKindRoutesData } = await import("@/lib/approval-kind-routes/data");
    const { fulfillApprovalRoutesPatch } = await import("@/lib/approval-kind-routes/mcp-handlers");
    resetDemoApprovalKindRoutesData();
    const approval = makeApproval({
      id: "apr_routes_approvedby_on",
      tool: "approvalRoutes.patch",
      metadata: {
        argsSnapshot: {
          beforeSnapshot: null,
          afterSnapshot: {
            version: 1,
            policyId: "akr_on",
            policyName: "テスト",
            routes: [
              {
                kind: "post",
                approverUserIds: ["user-1"],
                quorum: { type: "any" },
                finalGoUserId: null,
                deadlineHours: null,
                onExpire: "fail_closed",
                remindEveryDays: 3,
              },
            ],
            updatedAt: new Date().toISOString(),
            updatedBy: "test",
          },
          diffSummary: ["新規ポリシーを作成します"],
        },
      },
    });
    const result = await fulfillApprovalRoutesPatch(approval, {});
    expect(result.ok).toBe(true);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === approval.id);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("admin.approvalRoutes.patch");
    expect(row!.metadata?.approvedBy).toBe(MASKED_APPROVER);
    expect(JSON.stringify(row!.metadata)).not.toContain("approver@example.com");
    expect(JSON.stringify(row!.metadata)).not.toContain(APPROVER_EMAIL);
    resetDemoApprovalKindRoutesData();
  });
});

describe("OFF delta: deputyActivate always persists metadata.reason", () => {
  test("flag OFF: omitted / empty reason still writes the reason key", async () => {
    process.env[DECISION] = "true";
    const original = pushRuntimeApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "サーバー増設費用決裁",
      purpose: "decision.request",
      summary: "【T2】サーバー増設費用決裁",
      risk: "medium",
      tool: "decision.request",
      jobId: "job_deputy_reason_off",
      metadata: { type: "decision_request", tier: "T2" },
    });
    const { handleDeputyActivate } = await import("@/lib/approval-kind-routes/mcp-handlers");
    const result = await handleDeputyActivate(mockAdminCred(), {
      approvalId: original.id,
      deputyUserId: "mem_1",
    });
    expect(result.ok).toBe(true);
    expect(result.approvalId).toBeTruthy();
    const row = getRuntimeAudit().find((e) => e.metadata?.originalApprovalId === original.id);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("decision.deputy_activated");
    expect(row!.metadata).toHaveProperty("reason");
  });
});
