/**
 * F8 Approval Workflow Integration
 *
 * Wraps existing approval resolution to support workflow voting.
 * When no workflow is configured, falls back to current OR/single-approver (AC W1).
 */

import type { ApprovalRequest, WorkflowProgress } from "@/lib/types";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { assertNotSelfApproval } from "@/lib/admin-mcp/self-approval";
import {
  handleWorkflowVote,
  isWorkflowApprovalComplete,
  getApprovalWorkflowProgress,
  initializeWorkflowForApproval,
} from "@/lib/approval-workflow";
import { resolveApprovalWithoutWorkflow as baseResolveApproval, getApprovalById } from "@/lib/data/approvals";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { withDemoWorkflowLock } from "@/lib/approval-workflow/lock";
import { getBallotsByInstanceId, demoWorkflowVoterIsCurrent } from "@/lib/approval-workflow/data";
import { evaluateQuorum } from "@/lib/approval-workflow/engine";

export type WorkflowResolverOptions = {
  revisionNote?: string;
  grokBotAgentId?: string | null;
  actorId?: string | null;
  voterUserId?: string;
  externalVoter?: { provider: "slack" | "telegram" | "line"; channelKey: string; userId: string };
  /** Server-derived provider event ID, scoped to the authenticated channel. */
  decisionId?: string;
};

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
  opts: WorkflowResolverOptions = {}
): Promise<WorkflowResolveResult> {
  const result = await (isDemoMode()
    ? withDemoWorkflowLock(`resolve:${id}`, () => resolveWorkflow(id, status, resolvedBy, orgId, opts))
    : resolveWorkflow(id, status, resolvedBy, orgId, opts));
  if (result.ok && !result.workflowComplete && result.approval && result.progress) {
    // Notification failure cannot undo an already committed vote or authorize execution.
    try {
      const { refreshWorkflowNotification } = await import("@/lib/notify/channels");
      await refreshWorkflowNotification(result.approval, result.progress);
    } catch { /* The status API remains the source of truth. No completion notification is sent. */ }
  }
  return result;
}

async function resolveWorkflow(
  id: string, status: "approved" | "rejected" | "revision_requested", resolvedBy: string,
  orgId: string, opts: WorkflowResolverOptions
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

  // Keep the base resolver's requester/resolver boundary before any ballot write,
  // including intermediate votes that do not reach baseResolveApproval yet.
  if (isAdminClassApproval(approval)) {
    assertNotSelfApproval(approval.metadata, {
      actor: resolvedBy,
      actorId: opts.actorId,
      grokBotAgentId: opts.grokBotAgentId,
    });
  }

  // Idempotent snapshot initialization is also required for tickets created by
  // an older application. A DB failure must never mean "no workflow".
  const { instance } = await initializeWorkflowForApproval(approval, approval.employeeId || null);

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
      workflowComplete: Boolean(resolved),
      workflowApproved: resolved?.status === "approved",
      workflowRejected: resolved?.status === "rejected",
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

  const voterUserId = isDemoMode() ? (opts.voterUserId || opts.actorId || resolvedBy) : (opts.voterUserId ?? opts.actorId ?? "");
  if (opts.externalVoter && !opts.decisionId) return { ok: false, approval, workflowApplied: true,
    workflowComplete: false, workflowApproved: false, workflowRejected: false, progress: null, reason: "workflow_event_id_required" };
  const vote = status === "approved" ? "approve" : "reject";

  // Production commits ballots, stage state, and base approval in one RPC.
  // Demo also supports retrying the old terminal-instance / pending-ticket gap.
  const recoverable = isDemoMode() && ["approved", "rejected"].includes(instance.status) &&
    demoWorkflowVoterIsCurrent(orgId, voterUserId) &&
    (await getBallotsByInstanceId(instance.id)).some(b => b.voterUserId === voterUserId && b.vote !== null);
  const voteResult = recoverable
    ? { voted: true, workflowComplete: true, workflowApproved: instance.status === "approved",
        workflowRejected: instance.status === "rejected", progress: await getApprovalWorkflowProgress(id),
        reason: "recovered", approval: undefined }
    : await handleWorkflowVote(id, voterUserId, vote, { ...opts, orgId, actor: resolvedBy,
        expectedStage: instance.finalGoPending ? "final_go" : instance.policySnapshot.stages[instance.currentStageIndex]?.id });

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
    const resolved = voteResult.approval ?? (isDemoMode() ? await baseResolveApproval(id, finalStatus, resolvedBy, orgId, {
      grokBotAgentId: opts.grokBotAgentId,
      actorId: opts.actorId,
    }) : null);

    return {
      ok: Boolean(resolved),
      approval: resolved,
      workflowApplied: true,
      workflowComplete: Boolean(resolved),
      workflowApproved: resolved?.status === "approved",
      workflowRejected: resolved?.status === "rejected",
      progress: voteResult.progress,
      reason: resolved ? voteResult.reason : "resolve_failed",
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

  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) throw new Error("workflow_unavailable");
    const { data, error } = await admin.rpc("approval_workflow_can_execute", { p_id: approval.id, p_org: approval.orgId });
    if (error || typeof data !== "boolean") throw new Error("workflow_execution_check_failed");
    return { canFulfill: data, reason: data ? "workflow_satisfied" : "workflow_not_approved" };
  }
  const initialized = await initializeWorkflowForApproval(approval, approval.employeeId || null);

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

  const instance = initialized.instance!;
  const ballots = await getBallotsByInstanceId(instance.id);
  for (const [index, stage] of instance.policySnapshot.stages.entries()) {
    const stageBallots = ballots.filter(b => b.stageId === stage.id && b.stageIndex === index && !b.isFinalGo)
      .map(b => b.vote === "approve" && !demoWorkflowVoterIsCurrent(approval.orgId, b.voterUserId) ? { ...b, vote: null } : b);
    if (!evaluateQuorum(stage.quorum, stageBallots).met || (stage.onReject === "fail_closed" && stageBallots.some(b => b.vote === "reject"))) {
      return { canFulfill: false, reason: "workflow_authority_revoked" };
    }
  }
  if (instance.finalGoPending || (instance.finalGoUserId && !ballots.some(b => b.isFinalGo && b.voterUserId === instance.finalGoUserId &&
    b.vote === "approve" && demoWorkflowVoterIsCurrent(approval.orgId, b.voterUserId)))) {
    return { canFulfill: false, reason: "workflow_final_go_required" };
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
