/**
 * F8 Approval Workflow Resolution
 *
 * Handles workflow-aware approval resolution:
 * - Creates workflow instance when approval is created (if policy matches)
 * - Casts ballot on approval resolve
 * - Advances stages and handles finalGo
 * - Returns whether the full workflow is complete
 */

import type {
  ApprovalRequest,
  ApprovalWorkflowBallot,
  ApprovalWorkflowInstance,
  WorkflowProgress,
} from "@/lib/types";
import { appendAuditEvent } from "@/lib/data/audit";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { mapApprovalRow } from "@/lib/data/mappers";
import { demoGetApproval } from "@/lib/data/demo-approvals-store";
import { assertNotSelfApproval } from "@/lib/admin-mcp/self-approval";
import { withDemoWorkflowLock } from "./lock";
import { validateApprovalWorkflowPolicy } from "./validate";
import {
  castBallot,
  createBallotsForStage,
  createFinalGoBallot,
  createWorkflowInstance,
  getBallotForVoter,
  getBallotsByInstanceId,
  getEffectiveApprovalWorkflowPolicy,
  getWorkflowInstanceByApprovalId,
  updateWorkflowInstance,
  mapInstanceRow,
  isDemoWorkflowInitialized,
  markDemoWorkflowInitialized,
  getDemoWorkflowVoterBinding,
  demoWorkflowVoterIsCurrent,
} from "./data";
import {
  buildWorkflowProgress,
  canVoterResolve,
  evaluateFinalGo,
  evaluateStageAdvance,
  shouldCreateWorkflowInstance,
} from "./engine";

export interface WorkflowInitResult {
  created: boolean;
  instance: ApprovalWorkflowInstance | null;
  ballots: ApprovalWorkflowBallot[];
  progress: WorkflowProgress | null;
}

export async function initializeWorkflowForApproval(
  approval: ApprovalRequest,
  employeeId: string | null
): Promise<WorkflowInitResult> {
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) throw new Error("workflow_unavailable");
    const { data, error } = await admin.rpc("initialize_approval_workflow", { p_id: approval.id, p_org: approval.orgId });
    if (error || typeof data !== "boolean") throw new Error("workflow_initialization_failed");
    if (!data) return { created: false, instance: null, ballots: [], progress: null };
    const instance = await getWorkflowInstanceByApprovalId(approval.id);
    if (!instance || instance.orgId !== approval.orgId) throw new Error("workflow_instance_missing");
    const ballots = await getBallotsByInstanceId(instance.id);
    return { created: false, instance, ballots, progress: buildWorkflowProgress(instance, ballots) };
  }
  return withDemoWorkflowLock(`init:${approval.id}`, async () => {
    const existing = await getWorkflowInstanceByApprovalId(approval.id);
    if (existing) {
      if (existing.orgId !== approval.orgId) throw new Error("workflow_org_mismatch");
      const ballots = await getBallotsByInstanceId(existing.id);
      return { created: false, instance: existing, ballots, progress: buildWorkflowProgress(existing, ballots) };
    }
    if (isDemoWorkflowInitialized(approval.id)) return { created: false, instance: null, ballots: [], progress: null };
    const result = await initializeDemoWorkflow(approval, employeeId);
    markDemoWorkflowInitialized(approval.id);
    return result;
  });
}

async function initializeDemoWorkflow(approval: ApprovalRequest, employeeId: string | null): Promise<WorkflowInitResult> {
  const effective = await getEffectiveApprovalWorkflowPolicy(
    approval.orgId,
    employeeId
  );

  if (!effective.policy) {
    return { created: false, instance: null, ballots: [], progress: null };
  }

  if (!validateApprovalWorkflowPolicy(effective.policy as unknown as Record<string, unknown>).ok) throw new Error("workflow_invalid_policy");

  if (!shouldCreateWorkflowInstance(effective.policy, approval.tool ?? null, approval.purpose)) {
    return { created: false, instance: null, ballots: [], progress: null };
  }

  const instance = await createWorkflowInstance({
    approvalId: approval.id,
    orgId: approval.orgId,
    policy: effective.policy,
  });

  if (!instance) {
    throw new Error("workflow_initialization_failed");
  }

  const firstStage = effective.policy.stages[0];
  const ballots = await createBallotsForStage({
    instanceId: instance.id,
    orgId: approval.orgId,
    stage: firstStage,
    stageIndex: 0,
  });

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action: "approval.requested",
    purpose: approval.purpose,
    summary: `ワークフロー開始: ${effective.policy.policyName} (${effective.policy.stages.length}ステージ)`,
    metadata: {
      approvalId: approval.id,
      instanceId: instance.id,
      policyId: effective.policy.policyId,
      stageName: firstStage.nameJa,
      voters: firstStage.voterUserIds.length,
    },
  });

  const progress = buildWorkflowProgress(instance, ballots);
  return { created: true, instance, ballots, progress };
}

export interface WorkflowVoteResult {
  approval?: ApprovalRequest;
  voted: boolean;
  ballot: ApprovalWorkflowBallot | null;
  instance: ApprovalWorkflowInstance | null;
  workflowComplete: boolean;
  workflowApproved: boolean;
  workflowRejected: boolean;
  progress: WorkflowProgress | null;
  reason: string;
}

export async function handleWorkflowVote(
  approvalId: string,
  voterUserId: string,
  vote: "approve" | "reject",
  opts: { orgId?: string; actor?: string; actorId?: string | null; grokBotAgentId?: string | null;
    externalVoter?: { provider: "slack" | "telegram" | "line"; channelKey: string; userId: string };
    decisionId?: string; expectedStage?: string } = {}
): Promise<WorkflowVoteResult> {
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin || !opts.orgId) throw new Error("workflow_unavailable");
    const { data, error } = await admin.rpc("cast_approval_workflow_vote", {
      p_id: approvalId, p_org: opts.orgId, p_voter: voterUserId, p_vote: vote,
      p_actor: opts.actor || voterUserId, p_actor_id: opts.actorId ?? null, p_agent: opts.grokBotAgentId ?? null,
      p_provider: opts.externalVoter?.provider ?? null, p_channel: opts.externalVoter?.channelKey ?? null,
      p_external: opts.externalVoter?.userId ?? null,
      p_decision_id: opts.decisionId ?? null, p_expected_stage: opts.expectedStage ?? null,
    });
    if (error || !data) throw new Error(error?.message === "self_approval_denied" ? "self_approval_denied" : "workflow_vote_failed");
    const instance = data.instance ? mapInstanceRow(data.instance) : null;
    const approval = data.approval ? mapApprovalRow(data.approval) : undefined;
    const ballots = instance ? await getBallotsByInstanceId(instance.id) : [];
    return { voted: data.accepted === true, ballot: null, instance, approval,
      workflowComplete: approval?.status === "approved" || approval?.status === "rejected",
      workflowApproved: approval?.status === "approved", workflowRejected: approval?.status === "rejected",
      progress: instance ? buildWorkflowProgress(instance, ballots) : null, reason: String(data.reason || "workflow_vote_failed") };
  }
  const voter = opts.externalVoter ? getDemoWorkflowVoterBinding(opts.orgId || "", opts.externalVoter) : voterUserId;
  return withDemoWorkflowLock(`vote:${approvalId}`, () => handleDemoWorkflowVote(approvalId, voter, vote, opts));
}

async function handleDemoWorkflowVote(approvalId: string, voterUserId: string, vote: "approve" | "reject", opts: {decisionId?: string; expectedStage?: string}): Promise<WorkflowVoteResult> {
  const instance = await getWorkflowInstanceByApprovalId(approvalId);

  if (!instance) {
    return {
      voted: false,
      ballot: null,
      instance: null,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: null,
      reason: "no_workflow_instance",
    };
  }

  const policy = instance.policySnapshot;
  if (!demoWorkflowVoterIsCurrent(instance.orgId, voterUserId)) return {
    voted: false, ballot: null, instance, workflowComplete: false, workflowApproved: false,
    workflowRejected: false, progress: null, reason: "voter_not_authorized",
  };
  const ticket = await demoGetApproval(approvalId);
  if (ticket) assertNotSelfApproval(ticket.metadata, { actorId: voterUserId });
  let stageId: string;

  if (instance.finalGoPending) {
    stageId = "final_go";
  } else {
    const currentStage = policy.stages[instance.currentStageIndex];
    if (!currentStage) {
      return {
        voted: false,
        ballot: null,
        instance,
        workflowComplete: false,
        workflowApproved: false,
        workflowRejected: false,
        progress: null,
        reason: "invalid_stage_index",
      };
    }
    stageId = currentStage.id;
  }
  const duplicate = opts.decisionId && (await getBallotsByInstanceId(instance.id)).some(b => b.decisionId === opts.decisionId);
  if (duplicate || (opts.expectedStage && opts.expectedStage !== stageId)) return {
    voted: false, ballot: null, instance, workflowComplete: false, workflowApproved: false, workflowRejected: false,
    progress: null, reason: duplicate ? "duplicate_decision" : "workflow_stage_changed",
  };

  const existingBallot = await getBallotForVoter(instance.id, stageId, voterUserId);
  const canVote = canVoterResolve(instance, voterUserId, existingBallot);

  if (!canVote.allowed) {
    const allBallots = await getBallotsByInstanceId(instance.id);
    return {
      voted: false,
      ballot: existingBallot,
      instance,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: buildWorkflowProgress(instance, allBallots),
      reason: canVote.reason,
    };
  }

  if (!existingBallot) {
    const allBallots = await getBallotsByInstanceId(instance.id);
    return {
      voted: false,
      ballot: null,
      instance,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: buildWorkflowProgress(instance, allBallots),
      reason: "ballot_not_found",
    };
  }

  const updatedBallot = await castBallot(existingBallot.id, vote, opts.decisionId);
  if (!updatedBallot) {
    const allBallots = await getBallotsByInstanceId(instance.id);
    return {
      voted: false,
      ballot: existingBallot,
      instance,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: buildWorkflowProgress(instance, allBallots),
      reason: "cast_ballot_failed",
    };
  }

  let allBallots = await getBallotsByInstanceId(instance.id);

  if (instance.finalGoPending) {
    const finalGoResult = evaluateFinalGo(instance, updatedBallot);

    if (finalGoResult.complete) {
      const newStatus = finalGoResult.approved ? "approved" : "rejected";
      const updatedInstance = await updateWorkflowInstance(instance.id, {
        status: newStatus,
        finalGoPending: false,
      });

      await appendAuditEvent({
        orgId: instance.orgId,
        employeeId: null,
        credentialId: null,
        action: "approval.resolved",
        purpose: "workflow.final_go",
        summary: finalGoResult.approved
          ? `ワークフロー最終Go承認: ${voterUserId}`
          : `ワークフロー最終Go却下: ${voterUserId}`,
        metadata: {
          approvalId,
          instanceId: instance.id,
          vote,
          voterUserId,
          finalGo: true,
        },
      });

      return {
        voted: true,
        ballot: updatedBallot,
        instance: updatedInstance,
        workflowComplete: true,
        workflowApproved: finalGoResult.approved,
        workflowRejected: finalGoResult.rejected,
        progress: buildWorkflowProgress(updatedInstance ?? instance, allBallots),
        reason: finalGoResult.reason,
      };
    }

    return {
      voted: true,
      ballot: updatedBallot,
      instance,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: buildWorkflowProgress(instance, allBallots),
      reason: "awaiting_final_go",
    };
  }

  const currentStage = policy.stages[instance.currentStageIndex];
  const stageBallots = allBallots.filter(
    (b) => b.stageId === currentStage.id && b.stageIndex === instance.currentStageIndex
  );

  const advanceResult = evaluateStageAdvance(instance, stageBallots, currentStage);

  await appendAuditEvent({
    orgId: instance.orgId,
    employeeId: null,
    credentialId: null,
    action: "approval.resolved",
    purpose: `workflow.stage.${currentStage.id}`,
    summary: `ワークフロー投票: ${currentStage.nameJa} - ${voterUserId} (${vote})`,
    metadata: {
      approvalId,
      instanceId: instance.id,
      stageId: currentStage.id,
      stageIndex: instance.currentStageIndex,
      vote,
      voterUserId,
    },
  });

  if (advanceResult.shouldReject) {
    const updatedInstance = await updateWorkflowInstance(instance.id, {
      status: "rejected",
    });

    return {
      voted: true,
      ballot: updatedBallot,
      instance: updatedInstance,
      workflowComplete: true,
      workflowApproved: false,
      workflowRejected: true,
      progress: buildWorkflowProgress(updatedInstance ?? instance, allBallots),
      reason: advanceResult.reason,
    };
  }

  if (!advanceResult.shouldAdvance) {
    return {
      voted: true,
      ballot: updatedBallot,
      instance,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: buildWorkflowProgress(instance, allBallots),
      reason: advanceResult.reason,
    };
  }

  if (advanceResult.finalGoPending) {
    const finalGoUserId = instance.finalGoUserId;
    if (finalGoUserId) {
      await createFinalGoBallot({
        instanceId: instance.id,
        orgId: instance.orgId,
        finalGoUserId,
      });
    }

    const updatedInstance = await updateWorkflowInstance(instance.id, {
      finalGoPending: true,
    });

    allBallots = await getBallotsByInstanceId(instance.id);

    return {
      voted: true,
      ballot: updatedBallot,
      instance: updatedInstance,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: buildWorkflowProgress(updatedInstance ?? instance, allBallots),
      reason: advanceResult.reason,
    };
  }

  if (advanceResult.newStatus === "approved") {
    const updatedInstance = await updateWorkflowInstance(instance.id, {
      status: "approved",
    });

    return {
      voted: true,
      ballot: updatedBallot,
      instance: updatedInstance,
      workflowComplete: true,
      workflowApproved: true,
      workflowRejected: false,
      progress: buildWorkflowProgress(updatedInstance ?? instance, allBallots),
      reason: advanceResult.reason,
    };
  }

  if (advanceResult.nextStageIndex !== null) {
    const nextStage = policy.stages[advanceResult.nextStageIndex];
    await createBallotsForStage({
      instanceId: instance.id,
      orgId: instance.orgId,
      stage: nextStage,
      stageIndex: advanceResult.nextStageIndex,
    });

    const updatedInstance = await updateWorkflowInstance(instance.id, {
      currentStageIndex: advanceResult.nextStageIndex,
    });

    allBallots = await getBallotsByInstanceId(instance.id);

    return {
      voted: true,
      ballot: updatedBallot,
      instance: updatedInstance,
      workflowComplete: false,
      workflowApproved: false,
      workflowRejected: false,
      progress: buildWorkflowProgress(updatedInstance ?? instance, allBallots),
      reason: advanceResult.reason,
    };
  }

  return {
    voted: true,
    ballot: updatedBallot,
    instance,
    workflowComplete: false,
    workflowApproved: false,
    workflowRejected: false,
    progress: buildWorkflowProgress(instance, allBallots),
    reason: "unknown_state",
  };
}

export async function getApprovalWorkflowProgress(
  approvalId: string
): Promise<WorkflowProgress | null> {
  const instance = await getWorkflowInstanceByApprovalId(approvalId);
  if (!instance) return null;

  const ballots = await getBallotsByInstanceId(instance.id);
  return buildWorkflowProgress(instance, ballots);
}

export async function isWorkflowApprovalComplete(
  approvalId: string
): Promise<{ hasWorkflow: boolean; complete: boolean; approved: boolean }> {
  const instance = await getWorkflowInstanceByApprovalId(approvalId);

  if (!instance) {
    return { hasWorkflow: false, complete: false, approved: false };
  }

  return {
    hasWorkflow: true,
    complete: instance.status !== "active",
    approved: instance.status === "approved",
  };
}
