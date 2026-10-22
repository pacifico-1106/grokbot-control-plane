/**
 * P1 Decision Workflow — Deputy Activation Tests
 *
 * Tests for deputy activation with always_human approval.
 * Key security invariants:
 * - Self-approval is forbidden
 * - Cross-org activation is forbidden
 * - Flag OFF means no activation
 *
 * Drive P1_DECISION_WORKFLOW_ENABLED via env (do not mock.module
 * @/lib/feature-flags — that replaces the whole module and drops
 * isAdminAuditSixFieldWriteEnabledForOrg / isAdminAuditWhoRequiredEnabledForOrg).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ApprovalRequest } from "@/lib/types";

const DECISION = "P1_DECISION_WORKFLOW_ENABLED";
let savedDecision: string | undefined;

beforeEach(() => {
  savedDecision = process.env[DECISION];
});

afterEach(() => {
  if (savedDecision === undefined) delete process.env[DECISION];
  else process.env[DECISION] = savedDecision;
});

function setDecisionWorkflow(on: boolean) {
  if (on) process.env[DECISION] = "true";
  else delete process.env[DECISION];
}

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
  test("validateDeputyActivation returns disabled when flag is OFF", async () => {
    setDecisionWorkflow(false);
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
    setDecisionWorkflow(false);
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
  test("validateDeputyActivation allows valid deputy", async () => {
    setDecisionWorkflow(true);
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
    setDecisionWorkflow(true);
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
    setDecisionWorkflow(true);
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
    setDecisionWorkflow(true);
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
    setDecisionWorkflow(true);
    const { isDeputyActivationRequest } = await import("./deputy");

    const approval = makeDecisionApproval(
      {},
      { type: "deputy_activation", approvalClass: "always_human" }
    );
    const result = isDeputyActivationRequest(approval);
    expect(result).toBe(true);
  });

  test("isDeputyActivationRequest returns false for regular decision", async () => {
    setDecisionWorkflow(true);
    const { isDeputyActivationRequest } = await import("./deputy");

    const approval = makeDecisionApproval();
    const result = isDeputyActivationRequest(approval);
    expect(result).toBe(false);
  });
});
