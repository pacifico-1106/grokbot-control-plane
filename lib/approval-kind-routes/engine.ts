/**
 * P1 Approval Kind Routes — Engine
 *
 * Evaluates kind-based approval routes, handles quorum (any/count/all),
 * deadline/onExpire, and reminders.
 *
 * Integrates with the existing F8 workflow system when routes are defined.
 */

import type {
  ApprovalKind,
  ApprovalKindQuorum,
  ApprovalKindRoute,
  DecisionTier,
  DecisionTierRoute,
  EffectiveApprovalKindRoute,
} from "./types";
import { getToolApprovalKind } from "./tool-kind-map";
import { getEffectiveApprovalKindRoute } from "./data";
import { isApprovalKindRoutesEnabled } from "@/lib/feature-flags";

/**
 * Quorum evaluation result for kind routes.
 */
export interface KindQuorumEvaluation {
  met: boolean;
  approved: number;
  rejected: number;
  pending: number;
  total: number;
  required: number;
  display: string;
}

/**
 * Evaluate quorum rule for kind routes.
 */
export function evaluateKindQuorum(
  rule: ApprovalKindQuorum,
  votes: { userId: string; vote: "approve" | "reject" | null }[]
): KindQuorumEvaluation {
  const total = votes.length;
  const approved = votes.filter((v) => v.vote === "approve").length;
  const rejected = votes.filter((v) => v.vote === "reject").length;
  const pending = votes.filter((v) => v.vote === null).length;

  let required: number;
  let display: string;
  let met: boolean;

  switch (rule.type) {
    case "any":
      required = 1;
      display = "1名";
      met = approved >= 1;
      break;

    case "count":
      required = rule.n;
      display = `${rule.n}名`;
      met = approved >= rule.n;
      break;

    case "all":
      required = total;
      display = "全員";
      met = approved >= total && pending === 0;
      break;

    default:
      required = 1;
      display = "1名";
      met = approved >= 1;
  }

  return { met, approved, rejected, pending, total, required, display };
}

/**
 * Format quorum display for Japanese UI.
 */
export function formatKindQuorumDisplay(
  rule: ApprovalKindQuorum,
  approved: number,
  total: number
): string {
  switch (rule.type) {
    case "any":
      return `${approved}/1`;
    case "count":
      return `${approved}/${rule.n}`;
    case "all":
      return `${approved}/${total} (全員)`;
    default:
      return `${approved}/?`;
  }
}

/**
 * Deadline status for an approval.
 */
export interface DeadlineStatus {
  hasDeadline: boolean;
  deadlineAt: Date | null;
  isExpired: boolean;
  remainingHours: number | null;
  expiresAction: "fail_closed" | "keep_open";
}

/**
 * Calculate deadline status for a kind route.
 */
export function calculateDeadlineStatus(
  route: ApprovalKindRoute,
  createdAt: Date
): DeadlineStatus {
  if (!route.deadlineHours) {
    return {
      hasDeadline: false,
      deadlineAt: null,
      isExpired: false,
      remainingHours: null,
      expiresAction: route.onExpire,
    };
  }

  const deadlineAt = new Date(
    createdAt.getTime() + route.deadlineHours * 60 * 60 * 1000
  );
  const now = new Date();
  const isExpired = now >= deadlineAt;
  const remainingMs = deadlineAt.getTime() - now.getTime();
  const remainingHours = isExpired ? 0 : Math.ceil(remainingMs / (60 * 60 * 1000));

  return {
    hasDeadline: true,
    deadlineAt,
    isExpired,
    remainingHours,
    expiresAction: route.onExpire,
  };
}

/**
 * Reminder status for an approval.
 */
export interface ReminderStatus {
  needsReminder: boolean;
  nextReminderAt: Date | null;
  daysSinceCreated: number;
  daysSinceLastReminder: number | null;
  remindEveryDays: number;
}

/**
 * Calculate reminder status for a kind route.
 */
export function calculateReminderStatus(
  route: ApprovalKindRoute,
  createdAt: Date,
  lastReminderAt: Date | null
): ReminderStatus {
  const now = new Date();
  const daysSinceCreated = Math.floor(
    (now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000)
  );

  let daysSinceLastReminder: number | null = null;
  if (lastReminderAt) {
    daysSinceLastReminder = Math.floor(
      (now.getTime() - lastReminderAt.getTime()) / (24 * 60 * 60 * 1000)
    );
  }

  const referenceDate = lastReminderAt || createdAt;
  const daysSinceReference = Math.floor(
    (now.getTime() - referenceDate.getTime()) / (24 * 60 * 60 * 1000)
  );
  const needsReminder = daysSinceReference >= route.remindEveryDays;

  const nextReminderMs =
    referenceDate.getTime() + route.remindEveryDays * 24 * 60 * 60 * 1000;
  const nextReminderAt = new Date(nextReminderMs);

  return {
    needsReminder,
    nextReminderAt,
    daysSinceCreated,
    daysSinceLastReminder,
    remindEveryDays: route.remindEveryDays,
  };
}

/**
 * Approval resolution result.
 */
export interface KindApprovalResolution {
  isComplete: boolean;
  isApproved: boolean;
  isRejected: boolean;
  isExpired: boolean;
  needsFinalGo: boolean;
  finalGoComplete: boolean;
  reason: string;
  quorum: KindQuorumEvaluation;
  deadline: DeadlineStatus;
}

/**
 * Resolve approval status based on kind route.
 * Excludes requester's vote and AI votes from the count.
 */
export function resolveKindApproval(
  route: ApprovalKindRoute,
  votes: { userId: string; vote: "approve" | "reject" | null }[],
  createdAt: Date,
  requesterId: string | null,
  aiUserIds: string[],
  finalGoVote: "approve" | "reject" | null = null
): KindApprovalResolution {
  // Filter out requester's vote and AI votes (security requirement)
  const validVotes = votes.filter((v) => {
    if (requesterId && v.userId === requesterId) return false;
    if (aiUserIds.includes(v.userId)) return false;
    return true;
  });

  const quorum = evaluateKindQuorum(route.quorum, validVotes);
  const deadline = calculateDeadlineStatus(route, createdAt);

  // Check for rejection (fail_closed on any reject)
  const hasReject = validVotes.some((v) => v.vote === "reject");
  if (hasReject) {
    return {
      isComplete: true,
      isApproved: false,
      isRejected: true,
      isExpired: false,
      needsFinalGo: false,
      finalGoComplete: false,
      reason: "rejected: vote rejected",
      quorum,
      deadline,
    };
  }

  // Check for deadline expiration
  if (deadline.isExpired && deadline.expiresAction === "fail_closed") {
    return {
      isComplete: true,
      isApproved: false,
      isRejected: false,
      isExpired: true,
      needsFinalGo: false,
      finalGoComplete: false,
      reason: "expired: deadline passed (fail_closed)",
      quorum,
      deadline,
    };
  }

  // Check if quorum not met
  if (!quorum.met) {
    return {
      isComplete: false,
      isApproved: false,
      isRejected: false,
      isExpired: deadline.isExpired,
      needsFinalGo: false,
      finalGoComplete: false,
      reason: `pending: quorum not met (${quorum.approved}/${quorum.required})`,
      quorum,
      deadline,
    };
  }

  // Quorum met - check for finalGo
  if (route.finalGoUserId) {
    if (finalGoVote === null) {
      return {
        isComplete: false,
        isApproved: false,
        isRejected: false,
        isExpired: false,
        needsFinalGo: true,
        finalGoComplete: false,
        reason: "pending: awaiting finalGo",
        quorum,
        deadline,
      };
    }

    if (finalGoVote === "reject") {
      return {
        isComplete: true,
        isApproved: false,
        isRejected: true,
        isExpired: false,
        needsFinalGo: true,
        finalGoComplete: true,
        reason: "rejected: finalGo rejected",
        quorum,
        deadline,
      };
    }

    return {
      isComplete: true,
      isApproved: true,
      isRejected: false,
      isExpired: false,
      needsFinalGo: true,
      finalGoComplete: true,
      reason: "approved: quorum met and finalGo approved",
      quorum,
      deadline,
    };
  }

  // No finalGo required
  return {
    isComplete: true,
    isApproved: true,
    isRejected: false,
    isExpired: false,
    needsFinalGo: false,
    finalGoComplete: false,
    reason: "approved: quorum met",
    quorum,
    deadline,
  };
}

/**
 * Get the approval kind for a tool.
 * Convenience re-export with additional context.
 */
export function getApprovalKind(tool: string | null | undefined): ApprovalKind {
  return getToolApprovalKind(tool);
}

/**
 * Get the effective route for an approval.
 * Returns null when flag is OFF (legacy behavior).
 */
export async function getRouteForApproval(
  orgId: string,
  tool: string | null | undefined,
  employeeId?: string | null,
  ownerUserId?: string
): Promise<EffectiveApprovalKindRoute | null> {
  if (!isApprovalKindRoutesEnabled()) {
    return null;
  }

  const kind = getToolApprovalKind(tool);
  return getEffectiveApprovalKindRoute(orgId, kind, employeeId, ownerUserId);
}

/**
 * Check if a user can vote on an approval based on kind route.
 * Excludes the requester (self-approval forbidden) and AI employees.
 */
export function canUserVoteOnKindApproval(
  route: ApprovalKindRoute,
  userId: string,
  requesterId: string | null,
  aiUserIds: string[]
): { allowed: boolean; reason: string } {
  // Self-approval forbidden
  if (requesterId && userId === requesterId) {
    return { allowed: false, reason: "self_approval_forbidden" };
  }

  // AI employees cannot vote
  if (aiUserIds.includes(userId)) {
    return { allowed: false, reason: "ai_voter_forbidden" };
  }

  // Check if user is in approvers list
  if (!route.approverUserIds.includes(userId)) {
    return { allowed: false, reason: "not_in_approvers" };
  }

  return { allowed: true, reason: "ok" };
}

/**
 * Decision tier routing (for D1/D2 PRs).
 */
export interface DecisionTierResolution {
  tier: DecisionTier;
  route: DecisionTierRoute;
  autoEscalated: boolean;
  escalationReason: string | null;
}

/**
 * Determine the appropriate decision tier based on amount and classification.
 * Used in D1 PR for decision.request routing.
 */
export function determineDecisionTier(
  tiers: DecisionTierRoute[],
  amountJpy: number | null,
  amountThresholdJpy: number,
  classification: string | null
): DecisionTierResolution | null {
  if (tiers.length === 0) return null;

  const t1 = tiers.find((t) => t.tier === "T1");
  const t2 = tiers.find((t) => t.tier === "T2");
  const t3 = tiers.find((t) => t.tier === "T3");

  // Classification-based auto-escalation to T3
  const t3Classifications = ["定款変更", "役員", "決算"];
  if (classification && t3Classifications.includes(classification)) {
    if (t3) {
      return {
        tier: "T3",
        route: t3,
        autoEscalated: true,
        escalationReason: `classification: ${classification}`,
      };
    }
  }

  // Amount-based auto-escalation to T2+
  if (amountJpy !== null && amountJpy >= amountThresholdJpy) {
    if (t2) {
      return {
        tier: "T2",
        route: t2,
        autoEscalated: true,
        escalationReason: `amount: ${amountJpy} >= ${amountThresholdJpy}`,
      };
    }
    if (t3) {
      return {
        tier: "T3",
        route: t3,
        autoEscalated: true,
        escalationReason: `amount: ${amountJpy} >= ${amountThresholdJpy} (no T2)`,
      };
    }
  }

  // Default to T1
  if (t1) {
    return {
      tier: "T1",
      route: t1,
      autoEscalated: false,
      escalationReason: null,
    };
  }

  // Fallback to first available tier
  return {
    tier: tiers[0].tier,
    route: tiers[0],
    autoEscalated: false,
    escalationReason: null,
  };
}

/**
 * Check if a tier can be downgraded.
 * Only owner (八坂) can downgrade, and it must be audited.
 */
export function canDowngradeTier(
  currentTier: DecisionTier,
  targetTier: DecisionTier,
  userId: string,
  ownerUserId: string
): { allowed: boolean; reason: string } {
  const tierRank = { T1: 1, T2: 2, T3: 3 };

  // Not a downgrade
  if (tierRank[targetTier] >= tierRank[currentTier]) {
    return { allowed: true, reason: "not_a_downgrade" };
  }

  // Only owner can downgrade
  if (userId !== ownerUserId) {
    return { allowed: false, reason: "only_owner_can_downgrade" };
  }

  return { allowed: true, reason: "owner_downgrade_allowed" };
}

/**
 * Get pending approvers who haven't voted yet.
 */
export function getPendingApprovers(
  route: ApprovalKindRoute,
  votes: { userId: string; vote: "approve" | "reject" | null }[],
  requesterId: string | null,
  aiUserIds: string[]
): string[] {
  const votedUserIds = new Set(
    votes.filter((v) => v.vote !== null).map((v) => v.userId)
  );

  return route.approverUserIds.filter((userId) => {
    // Exclude requester
    if (requesterId && userId === requesterId) return false;
    // Exclude AI
    if (aiUserIds.includes(userId)) return false;
    // Exclude already voted
    if (votedUserIds.has(userId)) return false;
    return true;
  });
}
