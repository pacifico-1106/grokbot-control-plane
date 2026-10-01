/**
 * P1 Decision Workflow — Deputy Activation
 *
 * Deputy can fulfill a decision on behalf of the requester.
 * Deputy activation creates an always_human approval request.
 *
 * Security:
 * - Self-approval forbidden (deputy cannot be the requester)
 * - Cross-org activation forbidden (deputy must be in same org)
 * - Deputy must be a valid user ID in the org
 * - Only active when P1_DECISION_WORKFLOW_ENABLED is ON
 */

import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";
import { appendAuditEvent } from "@/lib/data/audit";
import type { ApprovalRequest } from "@/lib/types";

/**
 * Deputy activation request input.
 */
export interface DeputyActivationInput {
  approvalId: string;
  deputyUserId: string;
  requesterId: string;
  requesterOrgId: string;
  reason?: string;
}

/**
 * Deputy activation result.
 */
export interface DeputyActivationResult {
  ok: boolean;
  code: string;
  message?: string;
  approvalId?: string;
}

/**
 * Validate deputy activation request.
 *
 * Security checks:
 * - Deputy cannot be the requester (self_approval_forbidden)
 * - Deputy must be in the same org (cross_org_forbidden)
 */
export function validateDeputyActivation(
  input: DeputyActivationInput,
  deputyOrgId: string | null
): { ok: true } | { ok: false; code: string; message: string } {
  if (!isDecisionWorkflowEnabled()) {
    return {
      ok: false,
      code: "decision_workflow_disabled",
      message: "P1_DECISION_WORKFLOW_ENABLED is OFF",
    };
  }

  if (!input.deputyUserId || !input.requesterId) {
    return {
      ok: false,
      code: "invalid_input",
      message: "deputyUserId and requesterId are required",
    };
  }

  if (input.deputyUserId === input.requesterId) {
    return {
      ok: false,
      code: "self_approval_forbidden",
      message: "Deputy cannot be the same as the requester",
    };
  }

  if (!deputyOrgId || deputyOrgId !== input.requesterOrgId) {
    return {
      ok: false,
      code: "cross_org_forbidden",
      message: "Deputy must be a member of the same organization",
    };
  }

  return { ok: true };
}

/**
 * Record deputy activation audit event.
 */
export async function recordDeputyActivation(
  approval: ApprovalRequest,
  deputyUserId: string,
  actorEmail: string
): Promise<void> {
  if (!isDecisionWorkflowEnabled()) {
    return;
  }

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action: "decision.deputy_activated",
    purpose: approval.purpose,
    summary: `決裁代理を委任: ${deputyUserId}`,
    actorEmail,
    metadata: {
      approvalId: approval.id,
      deputyUserId,
      tier: (approval.metadata as Record<string, unknown>)?.tier ?? null,
    },
  });
}

/**
 * Build always_human approval metadata for deputy activation.
 */
export function buildDeputyActivationApprovalMetadata(
  originalApproval: ApprovalRequest,
  deputyUserId: string,
  reason?: string
): Record<string, unknown> {
  const originalMeta = originalApproval.metadata as Record<string, unknown>;

  return {
    type: "deputy_activation",
    originalApprovalId: originalApproval.id,
    deputyUserId,
    tier: originalMeta.tier ?? null,
    activationReason: reason ?? "決裁代理の委任",
    requiresHumanApproval: true,
    approvalClass: "always_human",
  };
}

/**
 * Check if an approval is a deputy activation request.
 */
export function isDeputyActivationRequest(approval: ApprovalRequest): boolean {
  if (!isDecisionWorkflowEnabled()) return false;
  const metadata = approval.metadata as Record<string, unknown> | null;
  return (
    metadata?.type === "deputy_activation" &&
    metadata?.approvalClass === "always_human"
  );
}
