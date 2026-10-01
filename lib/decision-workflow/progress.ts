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
  quorumRequired: number | "all";
  quorumMet: boolean;
  deadlineAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  escalatedFrom?: DecisionTier;
  escalatedAt?: Date;
  resultRecordedAt?: Date;
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
 * Calculate decision progress from votes.
 */
export function calculateDecisionProgress(
  votes: DecisionVote[],
  approverUserIds: string[],
  quorum: { type: "any" | "count" | "all"; n?: number },
  requesterId: string,
  aiUserIds: string[] = []
): {
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  totalVoters: number;
  quorumMet: boolean;
  quorumRequired: number | "all";
} {
  const voteMap = new Map(votes.map((v) => [v.voterId, v]));
  const excludedIds = new Set([requesterId, ...aiUserIds]);

  const validApprovers = approverUserIds.filter((id) => !excludedIds.has(id));

  let approvedCount = 0;
  let rejectedCount = 0;
  let pendingCount = 0;

  for (const voterId of validApprovers) {
    const vote = voteMap.get(voterId);
    if (!vote) {
      pendingCount++;
    } else if (vote.vote === "approve") {
      approvedCount++;
    } else if (vote.vote === "reject") {
      rejectedCount++;
    } else {
      pendingCount++;
    }
  }

  const totalVoters = validApprovers.length;
  let quorumRequired: number | "all";

  if (quorum.type === "all") {
    quorumRequired = "all";
  } else if (quorum.type === "count" && typeof quorum.n === "number") {
    quorumRequired = Math.min(quorum.n, totalVoters);
  } else {
    quorumRequired = 1;
  }

  const quorumMet =
    quorumRequired === "all"
      ? approvedCount === totalVoters && totalVoters > 0
      : approvedCount >= quorumRequired;

  return {
    approvedCount,
    rejectedCount,
    pendingCount,
    totalVoters,
    quorumMet,
    quorumRequired,
  };
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

  const quorumNum =
    state.quorumRequired === "all" ? state.totalVoters : state.quorumRequired;
  const possibleApprovals = state.approvedCount + state.pendingCount;

  if (possibleApprovals < quorumNum) {
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
      summaryJa: `Quorum到達不可能 (${state.rejectedCount}名却下済み)`,
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
 * Generate progress summary text.
 */
export function generateProgressSummary(state: DecisionProgressState): string {
  const parts: string[] = [];

  parts.push(`Tier: ${state.tier}`);
  parts.push(`進捗: ${state.approvedCount}/${state.totalVoters}名承認`);

  if (state.rejectedCount > 0) {
    parts.push(`(${state.rejectedCount}名却下)`);
  }

  if (state.quorumMet) {
    parts.push("✓ Quorum達成");
  } else {
    const remaining =
      state.quorumRequired === "all"
        ? state.pendingCount
        : Math.max(0, (state.quorumRequired as number) - state.approvedCount);
    parts.push(`残り${remaining}名の承認が必要`);
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
