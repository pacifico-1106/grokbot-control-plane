/**
 * F8 Approval Workflow Engine
 *
 * Evaluates quorum rules (any/count/ratio/majority), handles fail_closed reject,
 * and manages stage advancement including finalGo.
 */

import type {
  ApprovalLane,
  ApprovalWorkflowBallot,
  ApprovalWorkflowInstance,
  BallotVote,
  OrgApprovalWorkflowPolicy,
  QuorumRule,
  WorkflowProgress,
  WorkflowStageProgress,
} from "@/lib/types";

export interface QuorumEvaluation {
  met: boolean;
  approved: number;
  rejected: number;
  pending: number;
  total: number;
  required: number;
  display: string;
}

export function evaluateQuorum(
  rule: QuorumRule,
  ballots: ApprovalWorkflowBallot[]
): QuorumEvaluation {
  const total = ballots.length;
  const approved = ballots.filter((b) => b.vote === "approve").length;
  const rejected = ballots.filter((b) => b.vote === "reject").length;
  const pending = ballots.filter((b) => b.vote === null).length;

  let required: number;
  let display: string;
  let met: boolean;

  switch (rule.type) {
    case "any":
      required = 1;
      display = "1";
      met = approved >= 1;
      break;

    case "count":
      required = rule.n;
      display = String(rule.n);
      met = approved >= rule.n;
      break;

    case "ratio": {
      const { numerator, denominator } = rule;
      required = Math.ceil((total * numerator) / denominator);
      display = `${numerator}/${denominator}`;
      met = approved >= required;
      break;
    }

    case "majority":
      required = Math.floor(total / 2) + 1;
      display = "majority";
      met = approved >= required;
      break;

    default:
      required = 1;
      display = "1";
      met = approved >= 1;
  }

  return { met, approved, rejected, pending, total, required, display };
}

export function formatQuorumDisplay(
  rule: QuorumRule,
  approved: number,
  total: number
): string {
  switch (rule.type) {
    case "any":
      return `${approved}/1`;
    case "count":
      return `${approved}/${rule.n}`;
    case "ratio":
      return `${approved}/${Math.ceil((total * rule.numerator) / rule.denominator)} (${rule.numerator}/${rule.denominator})`;
    case "majority":
      return `${approved}/${Math.floor(total / 2) + 1} (majority)`;
    default:
      return `${approved}/?`;
  }
}

export interface StageAdvanceResult {
  shouldAdvance: boolean;
  shouldReject: boolean;
  nextStageIndex: number | null;
  finalGoPending: boolean;
  newStatus: "active" | "approved" | "rejected";
  reason: string;
}

export function evaluateStageAdvance(
  instance: ApprovalWorkflowInstance,
  stageBallots: ApprovalWorkflowBallot[],
  stage: ApprovalLane
): StageAdvanceResult {
  const quorum = evaluateQuorum(stage.quorum, stageBallots);
  const hasReject = stageBallots.some((b) => b.vote === "reject");
  const policy = instance.policySnapshot;
  const isLastStage = instance.currentStageIndex >= policy.stages.length - 1;
  const hasFinalGo = Boolean(policy.finalGoUserId);

  if (hasReject && stage.onReject === "fail_closed") {
    return {
      shouldAdvance: false,
      shouldReject: true,
      nextStageIndex: null,
      finalGoPending: false,
      newStatus: "rejected",
      reason: "fail_closed: 1 reject rejects entire instance",
    };
  }

  if (!quorum.met) {
    return {
      shouldAdvance: false,
      shouldReject: false,
      nextStageIndex: null,
      finalGoPending: false,
      newStatus: "active",
      reason: `quorum not met: ${quorum.approved}/${quorum.required}`,
    };
  }

  if (!isLastStage) {
    return {
      shouldAdvance: true,
      shouldReject: false,
      nextStageIndex: instance.currentStageIndex + 1,
      finalGoPending: false,
      newStatus: "active",
      reason: "stage quorum met, advancing to next stage",
    };
  }

  if (hasFinalGo) {
    return {
      shouldAdvance: true,
      shouldReject: false,
      nextStageIndex: null,
      finalGoPending: true,
      newStatus: "active",
      reason: "all stages complete, awaiting finalGo",
    };
  }

  return {
    shouldAdvance: true,
    shouldReject: false,
    nextStageIndex: null,
    finalGoPending: false,
    newStatus: "approved",
    reason: "all stages complete, workflow approved",
  };
}

export interface FinalGoResult {
  complete: boolean;
  approved: boolean;
  rejected: boolean;
  reason: string;
}

export function evaluateFinalGo(
  instance: ApprovalWorkflowInstance,
  finalGoBallot: ApprovalWorkflowBallot | null
): FinalGoResult {
  if (!instance.finalGoPending) {
    return {
      complete: false,
      approved: false,
      rejected: false,
      reason: "finalGo not pending",
    };
  }

  if (!finalGoBallot || finalGoBallot.vote === null) {
    return {
      complete: false,
      approved: false,
      rejected: false,
      reason: "awaiting finalGo vote",
    };
  }

  if (finalGoBallot.vote === "reject") {
    return {
      complete: true,
      approved: false,
      rejected: true,
      reason: "finalGo rejected",
    };
  }

  return {
    complete: true,
    approved: true,
    rejected: false,
    reason: "finalGo approved",
  };
}

export function buildStageProgress(
  stage: ApprovalLane,
  stageIndex: number,
  ballots: ApprovalWorkflowBallot[]
): WorkflowStageProgress {
  const stageBallots = ballots.filter(
    (b) => b.stageId === stage.id && b.stageIndex === stageIndex && !b.isFinalGo
  );
  const quorum = evaluateQuorum(stage.quorum, stageBallots);

  return {
    stageId: stage.id,
    stageIndex,
    nameJa: stage.nameJa,
    approved: quorum.approved,
    rejected: quorum.rejected,
    pending: quorum.pending,
    total: quorum.total,
    quorumDisplay: formatQuorumDisplay(stage.quorum, quorum.approved, quorum.total),
    quorumMet: quorum.met,
  };
}

export function buildWorkflowProgress(
  instance: ApprovalWorkflowInstance,
  ballots: ApprovalWorkflowBallot[]
): WorkflowProgress {
  const policy = instance.policySnapshot;
  const stages = policy.stages.map((stage, index) =>
    buildStageProgress(stage, index, ballots)
  );

  const currentStage =
    instance.currentStageIndex < stages.length
      ? stages[instance.currentStageIndex]
      : null;

  const finalGoBallot = ballots.find((b) => b.isFinalGo);
  const finalGoVoted = Boolean(finalGoBallot?.vote);

  return {
    instanceId: instance.id,
    status: instance.status,
    currentStageIndex: instance.currentStageIndex,
    currentStage,
    stages,
    finalGoPending: instance.finalGoPending,
    finalGoUserId: instance.finalGoUserId,
    finalGoVoted,
  };
}

export function shouldCreateWorkflowInstance(
  policy: OrgApprovalWorkflowPolicy | null,
  tool: string | null,
  purpose: string
): boolean {
  if (!policy) return false;
  if (!policy.stages || policy.stages.length === 0) return false;

  const match = policy.match;
  if (!match) return true;

  if (match.tools && match.tools.length > 0) {
    if (!tool || !match.tools.includes(tool)) return false;
  }

  if (match.purposes && match.purposes.length > 0) {
    if (!match.purposes.includes(purpose)) return false;
  }

  return true;
}

export function isVoterInCurrentStage(
  instance: ApprovalWorkflowInstance,
  voterUserId: string
): boolean {
  const policy = instance.policySnapshot;

  if (instance.finalGoPending) {
    return instance.finalGoUserId === voterUserId;
  }

  const currentStage = policy.stages[instance.currentStageIndex];
  if (!currentStage) return false;

  return currentStage.voterUserIds.includes(voterUserId);
}

export function canVoterResolve(
  instance: ApprovalWorkflowInstance,
  voterUserId: string,
  existingBallot: ApprovalWorkflowBallot | null
): { allowed: boolean; reason: string } {
  if (instance.status !== "active") {
    return { allowed: false, reason: "workflow_not_active" };
  }

  if (!isVoterInCurrentStage(instance, voterUserId)) {
    return { allowed: false, reason: "not_in_current_stage" };
  }

  if (existingBallot !== null && existingBallot.vote !== null) {
    return { allowed: false, reason: "already_voted" };
  }

  return { allowed: true, reason: "ok" };
}
