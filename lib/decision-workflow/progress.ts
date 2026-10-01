/**
 * P1 Decision Workflow — Progress Tracking
 *
 * Track voting progress and status for decision requests.
 * Integrates with Stuck Watch for stalled decisions.
 */

import type { DecisionTier } from "@/lib/approval-kind-routes/types";
import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";

/**
 * Decision vote record.
 */
export interface DecisionVote {
  voterId: string;
  vote: "approve" | "reject" | "abstain";
  comment?: string;
  votedAt: Date;
  weight?: number;
}

/**
 * Decision progress state.
 */
export interface DecisionProgressState {
  approvalId: string;
  tier: DecisionTier;
  status: "pending" | "approved" | "rejected" | "expired" | "escalated";
  votes: DecisionVote[];
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  totalVoters: number;
  quorumRequired: number | "all" | { type: "weight"; min: number };
  quorumMet: boolean;
  deadlineAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  escalatedFrom?: DecisionTier;
  escalatedAt?: Date;
  resultRecordedAt?: Date;
  /** Weighted vote totals (present when voterWeights are configured) */
  weighted?: {
    approvedWeight: number;
    rejectedWeight: number;
    pendingWeight: number;
    totalWeight: number;
  };
}

/**
 * Stuck Watch item for decision workflow.
 */
export interface DecisionStuckItem {
  kind: "decision_stalled";
  approvalId: string;
  tier: DecisionTier;
  reason: "no_votes" | "deadline_approaching" | "quorum_unreachable";
  stalledSince: Date;
  daysSinceCreation: number;
  progress: {
    approved: number;
    rejected: number;
    pending: number;
    total: number;
  };
  deadlineAt: Date | null;
  summaryJa: string;
  nextStepJa: string;
}

/**
 * Result of decision progress calculation.
 */
export interface DecisionProgressResult {
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  totalVoters: number;
  quorumMet: boolean;
  quorumRequired: number | "all" | { type: "weight"; min: number };
  /** Weighted totals when voterWeights are provided */
  weighted?: {
    approvedWeight: number;
    rejectedWeight: number;
    pendingWeight: number;
    totalWeight: number;
  };
}

/**
 * Calculate decision progress from votes.
 *
 * @param votes - Array of votes cast
 * @param approverUserIds - List of valid approver user IDs
 * @param quorum - Quorum configuration
 * @param requesterId - Requester ID (excluded from voting)
 * @param aiUserIds - AI user IDs (excluded from voting)
 * @param voterWeights - Optional weights per voter (default: 1 for each)
 */
export function calculateDecisionProgress(
  votes: DecisionVote[],
  approverUserIds: string[],
  quorum: { type: "any" | "count" | "all" | "weight"; n?: number; min?: number },
  requesterId: string,
  aiUserIds: string[] = [],
  voterWeights?: Record<string, number>
): DecisionProgressResult {
  const voteMap = new Map(votes.map((v) => [v.voterId, v]));
  const excludedIds = new Set([requesterId, ...aiUserIds]);

  const validApprovers = approverUserIds.filter((id) => !excludedIds.has(id));

  let approvedCount = 0;
  let rejectedCount = 0;
  let pendingCount = 0;

  let approvedWeight = 0;
  let rejectedWeight = 0;
  let pendingWeight = 0;
  let totalWeight = 0;

  for (const voterId of validApprovers) {
    const weight = voterWeights?.[voterId] ?? 1;
    totalWeight += weight;

    const vote = voteMap.get(voterId);
    if (!vote) {
      pendingCount++;
      pendingWeight += weight;
    } else if (vote.vote === "approve") {
      approvedCount++;
      approvedWeight += weight;
    } else if (vote.vote === "reject") {
      rejectedCount++;
      rejectedWeight += weight;
    } else {
      pendingCount++;
      pendingWeight += weight;
    }
  }

  const totalVoters = validApprovers.length;
  let quorumRequired: number | "all" | { type: "weight"; min: number };
  let quorumMet: boolean;

  if (quorum.type === "weight" && typeof quorum.min === "number") {
    quorumRequired = { type: "weight", min: quorum.min };
    quorumMet = approvedWeight >= quorum.min;
  } else if (quorum.type === "all") {
    quorumRequired = "all";
    quorumMet = approvedCount === totalVoters && totalVoters > 0;
  } else if (quorum.type === "count" && typeof quorum.n === "number") {
    quorumRequired = Math.min(quorum.n, totalVoters);
    quorumMet = approvedCount >= quorumRequired;
  } else {
    quorumRequired = 1;
    quorumMet = approvedCount >= 1;
  }

  const result: DecisionProgressResult = {
    approvedCount,
    rejectedCount,
    pendingCount,
    totalVoters,
    quorumMet,
    quorumRequired,
  };

  if (voterWeights && Object.keys(voterWeights).length > 0) {
    result.weighted = {
      approvedWeight,
      rejectedWeight,
      pendingWeight,
      totalWeight,
    };
  }

  return result;
}

/**
 * Check if decision is stalled.
 */
export function checkDecisionStalled(
  state: DecisionProgressState,
  now: Date = new Date()
): DecisionStuckItem | null {
  if (!isDecisionWorkflowEnabled()) return null;
  if (state.status !== "pending") return null;

  const daysSinceCreation = Math.floor(
    (now.getTime() - state.createdAt.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (state.votes.length === 0 && daysSinceCreation >= 1) {
    return {
      kind: "decision_stalled",
      approvalId: state.approvalId,
      tier: state.tier,
      reason: "no_votes",
      stalledSince: state.createdAt,
      daysSinceCreation,
      progress: {
        approved: state.approvedCount,
        rejected: state.rejectedCount,
        pending: state.pendingCount,
        total: state.totalVoters,
      },
      deadlineAt: state.deadlineAt,
      summaryJa: `決裁依頼に${daysSinceCreation}日間投票がありません`,
      nextStepJa: "承認者に連絡してください",
    };
  }

  if (state.deadlineAt) {
    const hoursToDeadline = (state.deadlineAt.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursToDeadline > 0 && hoursToDeadline <= 24 && !state.quorumMet) {
      return {
        kind: "decision_stalled",
        approvalId: state.approvalId,
        tier: state.tier,
        reason: "deadline_approaching",
        stalledSince: now,
        daysSinceCreation,
        progress: {
          approved: state.approvedCount,
          rejected: state.rejectedCount,
          pending: state.pendingCount,
          total: state.totalVoters,
        },
        deadlineAt: state.deadlineAt,
        summaryJa: `決裁依頼の期限まで${Math.floor(hoursToDeadline)}時間です`,
        nextStepJa: state.tier === "T2" ? "期限切れで自動却下されます" : "承認者に連絡してください",
      };
    }
  }

  // Check if quorum is unreachable
  let quorumUnreachable = false;
  let quorumSummary = "";

  if (typeof state.quorumRequired === "object" && state.quorumRequired.type === "weight") {
    // For weighted quorum, check if possible weight is below required
    const possibleWeight = (state.weighted?.approvedWeight ?? 0) + (state.weighted?.pendingWeight ?? 0);
    if (possibleWeight < state.quorumRequired.min) {
      quorumUnreachable = true;
      quorumSummary = `Quorum到達不可能 (${state.weighted?.rejectedWeight ?? 0}pt却下済み)`;
    }
  } else {
    const quorumNum =
      state.quorumRequired === "all" ? state.totalVoters : (state.quorumRequired as number);
    const possibleApprovals = state.approvedCount + state.pendingCount;
    if (possibleApprovals < quorumNum) {
      quorumUnreachable = true;
      quorumSummary = `Quorum到達不可能 (${state.rejectedCount}名却下済み)`;
    }
  }

  if (quorumUnreachable) {
    return {
      kind: "decision_stalled",
      approvalId: state.approvalId,
      tier: state.tier,
      reason: "quorum_unreachable",
      stalledSince: now,
      daysSinceCreation,
      progress: {
        approved: state.approvedCount,
        rejected: state.rejectedCount,
        pending: state.pendingCount,
        total: state.totalVoters,
      },
      deadlineAt: state.deadlineAt,
      summaryJa: quorumSummary,
      nextStepJa: "決裁依頼を取り下げて再申請を検討してください",
    };
  }

  return null;
}

/**
 * Check if decision should be auto-expired.
 */
export function shouldAutoExpire(
  state: DecisionProgressState,
  now: Date = new Date()
): boolean {
  if (state.status !== "pending") return false;
  if (!state.deadlineAt) return false;

  return now > state.deadlineAt && state.tier === "T2";
}

/**
 * T2 Expiry Result
 */
export interface T2ExpiryResult {
  expired: boolean;
  status: "rejected" | "unchanged";
  reason: string;
  error?: string;
}

/**
 * Handle T2 decision expiry with fail_closed semantics.
 *
 * SECURITY: On any error, we NEVER approve - fail closed to rejected.
 * This ensures that a malfunction cannot result in unauthorized approval.
 *
 * @returns Expiry result with status "rejected" if expired, "unchanged" if not
 */
export function handleT2Expiry(
  state: DecisionProgressState,
  now: Date = new Date()
): T2ExpiryResult {
  if (!isDecisionWorkflowEnabled()) {
    return { expired: false, status: "unchanged", reason: "decision_workflow_disabled" };
  }

  if (state.status !== "pending") {
    return { expired: false, status: "unchanged", reason: "already_resolved" };
  }

  if (state.tier !== "T2") {
    return { expired: false, status: "unchanged", reason: "not_t2" };
  }

  if (!state.deadlineAt) {
    return { expired: false, status: "unchanged", reason: "no_deadline" };
  }

  try {
    if (now > state.deadlineAt) {
      return {
        expired: true,
        status: "rejected",
        reason: "deadline_exceeded",
      };
    }

    return { expired: false, status: "unchanged", reason: "deadline_not_reached" };
  } catch (error) {
    return {
      expired: true,
      status: "rejected",
      reason: "error_fail_closed",
      error: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

/**
 * Generate progress summary text.
 */
export function generateProgressSummary(state: DecisionProgressState): string {
  const parts: string[] = [];

  parts.push(`Tier: ${state.tier}`);

  if (state.weighted) {
    parts.push(`進捗: ${state.weighted.approvedWeight}/${state.weighted.totalWeight}pt承認`);
    if (state.rejectedCount > 0) {
      parts.push(`(${state.weighted.rejectedWeight}pt却下)`);
    }
  } else {
    parts.push(`進捗: ${state.approvedCount}/${state.totalVoters}名承認`);
    if (state.rejectedCount > 0) {
      parts.push(`(${state.rejectedCount}名却下)`);
    }
  }

  if (state.quorumMet) {
    parts.push("✓ Quorum達成");
  } else {
    if (typeof state.quorumRequired === "object" && state.quorumRequired.type === "weight") {
      const remaining = Math.max(0, state.quorumRequired.min - (state.weighted?.approvedWeight ?? 0));
      parts.push(`残り${remaining}ptの承認が必要`);
    } else if (state.quorumRequired === "all") {
      parts.push(`残り${state.pendingCount}名の承認が必要`);
    } else {
      const remaining = Math.max(0, (state.quorumRequired as number) - state.approvedCount);
      parts.push(`残り${remaining}名の承認が必要`);
    }
  }

  if (state.deadlineAt) {
    const now = new Date();
    if (now > state.deadlineAt) {
      parts.push("⚠️ 期限切れ");
    } else {
      const hoursLeft = Math.floor((state.deadlineAt.getTime() - now.getTime()) / (1000 * 60 * 60));
      parts.push(`期限まで${hoursLeft}時間`);
    }
  }

  return parts.join(" | ");
}
