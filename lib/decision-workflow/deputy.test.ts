/**
 * P1 Decision Workflow — Deputy Activation Tests
 *
 * Tests for deputy activation with always_human approval.
 * Key security invariants:
 * - Self-approval is forbidden
 * - Cross-org activation is forbidden
 * - Flag OFF means no activation
 */

import { describe, expect, test, mock } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ApprovalRequest } from "@/lib/types";

function makeDecisionApproval(
  overrides: Partial<ApprovalRequest> = {},
  metadataOverrides: Record<string, unknown> = {}
): ApprovalRequest {
  return {
    id: "apr_decision_1",
    orgId: DEMO_ORG.id,
    employeeId: "emp_requester",
    credentialId: "cred_requester",
    title: "サーバー増設費用決裁",
    purpose: "decision.request",
    summary: "【T2】サーバー増設費用決裁",
    risk: "medium" as const,
    status: "pending" as const,
    tool: "decision.request",
    jobId: "job_decision_1",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: null,
    telegramMessageId: null,
    metadata: {
      type: "decision_request",
      tier: "T2",
      ...metadataOverrides,
    },
    statusToken: "token_decision_1",
    pollPath: "/api/approvals/status?id=apr_decision_1&token=token_decision_1",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe("Deputy activation — flag OFF behavior", () => {
  mock.module("@/lib/feature-flags", () => ({
    isDecisionWorkflowEnabled: () => false,
  }));

  test("validateDeputyActivation returns disabled when flag is OFF", async () => {
    mock.module("@/lib/feature-flags", () => ({
      isDecisionWorkflowEnabled: () => false,
    }));
    const { validateDeputyActivation } = await import("./deputy");

    const result = validateDeputyActivation(
      {
        approvalId: "apr_1",
        deputyUserId: "deputy_user",
        requesterId: "requester_user",
        requesterOrgId: DEMO_ORG.id,
      },
      DEMO_ORG.id
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("decision_workflow_disabled");
    }
  });

  test("isDeputyActivationRequest returns false when flag is OFF", async () => {
    mock.module("@/lib/feature-flags", () => ({
      isDecisionWorkflowEnabled: () => false,
    }));
    const { isDeputyActivationRequest } = await import("./deputy");

    const approval = makeDecisionApproval(
      {},
      { type: "deputy_activation", approvalClass: "always_human" }
    );
    const result = isDeputyActivationRequest(approval);
    expect(result).toBe(false);
  });
});

describe("Deputy activation — flag ON behavior", () => {
  mock.module("@/lib/feature-flags", () => ({
    isDecisionWorkflowEnabled: () => true,
  }));

  test("validateDeputyActivation allows valid deputy", async () => {
    mock.module("@/lib/feature-flags", () => ({
      isDecisionWorkflowEnabled: () => true,
    }));
    const { validateDeputyActivation } = await import("./deputy");

    const result = validateDeputyActivation(
      {
        approvalId: "apr_1",
        deputyUserId: "deputy_user",
        requesterId: "requester_user",
        requesterOrgId: DEMO_ORG.id,
      },
      DEMO_ORG.id
    );

    expect(result.ok).toBe(true);
  });

  test("SECURITY: rejects self-approval (deputy = requester)", async () => {
    mock.module("@/lib/feature-flags", () => ({
      isDecisionWorkflowEnabled: () => true,
    }));
    const { validateDeputyActivation } = await import("./deputy");

    const result = validateDeputyActivation(
      {
        approvalId: "apr_1",
        deputyUserId: "same_user",
        requesterId: "same_user",
        requesterOrgId: DEMO_ORG.id,
      },
      DEMO_ORG.id
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("self_approval_forbidden");
    }
  });

  test("SECURITY: rejects cross-org deputy", async () => {
    mock.module("@/lib/feature-flags", () => ({
      isDecisionWorkflowEnabled: () => true,
    }));
    const { validateDeputyActivation } = await import("./deputy");

    const result = validateDeputyActivation(
      {
        approvalId: "apr_1",
        deputyUserId: "deputy_user",
        requesterId: "requester_user",
        requesterOrgId: DEMO_ORG.id,
      },
      "different_org_id"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cross_org_forbidden");
    }
  });

  test("SECURITY: rejects deputy with null orgId", async () => {
    mock.module("@/lib/feature-flags", () => ({
      isDecisionWorkflowEnabled: () => true,
    }));
    const { validateDeputyActivation } = await import("./deputy");

    const result = validateDeputyActivation(
      {
        approvalId: "apr_1",
        deputyUserId: "deputy_user",
        requesterId: "requester_user",
        requesterOrgId: DEMO_ORG.id,
      },
      null
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cross_org_forbidden");
    }
  });

  test("buildDeputyActivationApprovalMetadata sets always_human", async () => {
    const { buildDeputyActivationApprovalMetadata } = await import("./deputy");

    const approval = makeDecisionApproval();
    const metadata = buildDeputyActivationApprovalMetadata(
      approval,
      "deputy_user",
      "緊急対応のため"
    );

    expect(metadata.type).toBe("deputy_activation");
    expect(metadata.approvalClass).toBe("always_human");
    expect(metadata.requiresHumanApproval).toBe(true);
    expect(metadata.deputyUserId).toBe("deputy_user");
    expect(metadata.originalApprovalId).toBe(approval.id);
    expect(metadata.activationReason).toBe("緊急対応のため");
  });

  test("isDeputyActivationRequest returns true for deputy activation", async () => {
    mock.module("@/lib/feature-flags", () => ({
      isDecisionWorkflowEnabled: () => true,
    }));
    const { isDeputyActivationRequest } = await import("./deputy");

    const approval = makeDecisionApproval(
      {},
      { type: "deputy_activation", approvalClass: "always_human" }
    );
    const result = isDeputyActivationRequest(approval);
    expect(result).toBe(true);
  });

  test("isDeputyActivationRequest returns false for regular decision", async () => {
    mock.module("@/lib/feature-flags", () => ({
      isDecisionWorkflowEnabled: () => true,
    }));
    const { isDeputyActivationRequest } = await import("./deputy");

    const approval = makeDecisionApproval();
    const result = isDeputyActivationRequest(approval);
    expect(result).toBe(false);
  });
});
