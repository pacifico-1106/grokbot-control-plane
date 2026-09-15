/**
 * F8 Approval Workflow Integration
 *
 * Wraps existing approval resolution to support workflow voting.
 * When no workflow is configured, falls back to current OR/single-approver (AC W1).
 */

import type { ApprovalRequest, WorkflowProgress } from "@/lib/types";
import {
  getWorkflowInstanceByApprovalId,
  handleWorkflowVote,
  isWorkflowApprovalComplete,
  getApprovalWorkflowProgress,
  initializeWorkflowForApproval,
} from "@/lib/approval-workflow";
import { resolveApproval as baseResolveApproval, getApprovalById } from "@/lib/data/approvals";

export interface WorkflowResolveResult {
  ok: boolean;
  approval: ApprovalRequest | null;
  workflowApplied: boolean;
  workflowComplete: boolean;
  workflowApproved: boolean;
  workflowRejected: boolean;
  progress: WorkflowProgress | null;
  reason: string;
}

/**
 * Resolve an approval with workflow awareness.
 *
 * When workflow policy applies:
 * - Cast a ballot for the voter
 * - If workflow completes (all stages + finalGo), update the underlying approval
 * - Return progress for UI updates
 *
 * When no workflow (default):
 * - Falls back to existing OR/single-approver behavior (AC W1)
 */
export async function resolveApprovalWithWorkflow(
  id: string,
  status: "approved" | "rejected" | "revision_requested",
  resolvedBy: string,
  orgId: string,
  opts: {
    revisionNote?: string;
    grokBotAgentId?: string | null;
    actorId?: string | null;
    voterUserId?: string;
  } = {}
): Promise<WorkflowResolveResult> {
  const approval = await getApprovalById(id, orgId);
  if (!approval) {
    return {
      ok: false,
      approval: null,
      workflowApplied: false,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: null,
      reason: "approval_not_found",
    };
  }

  if (approval.status !== "pending") {
    return {
      ok: false,
      approval,
      workflowApplied: false,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: null,
      reason: "approval_not_pending",
    };
  }

  const instance = await getWorkflowInstanceByApprovalId(id);

  if (!instance) {
    const resolved = await baseResolveApproval(id, status, resolvedBy, orgId, {
      revisionNote: opts.revisionNote,
      grokBotAgentId: opts.grokBotAgentId,
      actorId: opts.actorId,
    });

    return {
      ok: Boolean(resolved),
      approval: resolved,
      workflowApplied: false,
      workflowComplete: true,
      workflowApproved: status === "approved",
      workflowRejected: status === "rejected",
      progress: null,
      reason: resolved ? "resolved_no_workflow" : "resolve_failed",
    };
  }

  if (status === "revision_requested") {
    return {
      ok: false,
      approval,
      workflowApplied: true,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: await getApprovalWorkflowProgress(id),
      reason: "revision_not_supported_in_workflow",
    };
  }

  const voterUserId = opts.voterUserId || opts.actorId || resolvedBy;
  const vote = status === "approved" ? "approve" : "reject";

  const voteResult = await handleWorkflowVote(id, voterUserId, vote);

  if (!voteResult.voted) {
    return {
      ok: false,
      approval,
      workflowApplied: true,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: voteResult.progress,
      reason: voteResult.reason,
    };
  }

  if (voteResult.workflowComplete) {
    const finalStatus = voteResult.workflowApproved ? "approved" : "rejected";
    const resolved = await baseResolveApproval(id, finalStatus, resolvedBy, orgId, {
      grokBotAgentId: opts.grokBotAgentId,
      actorId: opts.actorId,
    });

    return {
      ok: Boolean(resolved),
      approval: resolved,
      workflowApplied: true,
      workflowComplete: true,
      workflowApproved: voteResult.workflowApproved,
      workflowRejected: voteResult.workflowRejected,
      progress: voteResult.progress,
      reason: voteResult.reason,
    };
  }

  return {
    ok: true,
    approval,
    workflowApplied: true,
    workflowComplete: false,
    workflowApproved: false,
    workflowRejected: false,
    progress: voteResult.progress,
    reason: voteResult.reason,
  };
}

/**
 * Check if an approval's workflow is complete (or has no workflow).
 * Used by fulfillIfApproved to guard actual fulfillment.
 */
export async function canFulfillApproval(
  approval: ApprovalRequest
): Promise<{ canFulfill: boolean; reason: string }> {
  if (approval.status !== "approved") {
    return { canFulfill: false, reason: "not_approved" };
  }

  const workflowStatus = await isWorkflowApprovalComplete(approval.id);

  if (!workflowStatus.hasWorkflow) {
    return { canFulfill: true, reason: "no_workflow" };
  }

  if (!workflowStatus.complete) {
    return { canFulfill: false, reason: "workflow_not_complete" };
  }

  if (!workflowStatus.approved) {
    return { canFulfill: false, reason: "workflow_not_approved" };
  }

  return { canFulfill: true, reason: "workflow_approved" };
}

/**
 * Initialize workflow for a newly created approval.
 * Call this after createApproval when needs_approval is returned.
 */
export async function maybeInitializeWorkflow(
  approval: ApprovalRequest,
  employeeId: string | null
): Promise<{ initialized: boolean; progress: WorkflowProgress | null }> {
  const result = await initializeWorkflowForApproval(approval, employeeId);
  return {
    initialized: result.created,
    progress: result.progress,
  };
}

/**
 * Get workflow progress for an approval.
 * Returns null if no workflow is configured for this approval.
 */
export { getApprovalWorkflowProgress };
