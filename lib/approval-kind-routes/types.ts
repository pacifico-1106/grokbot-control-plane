/**
 * P1 Approval Kind Routes — Types
 *
 * Per-kind approval routing with quorum, finalGo, deadline, reminders.
 * Security invariants:
 * - No AI approvers (ai_approver_forbidden)
 * - No self-approval (self_approval_forbidden)
 * - account kind requires owner/admin human approvers only
 * - Tool→kind mapping is fixed in code (no tenant override)
 */

/** Approval kind categories. */
export type ApprovalKind = "post" | "mail" | "account" | "decision" | "other";

/** All approval kinds in order. */
export const APPROVAL_KINDS: readonly ApprovalKind[] = [
  "post",
  "mail",
  "account",
  "decision",
  "other",
] as const;

/** Quorum rule for approval routes. */
export type ApprovalKindQuorum =
  | { type: "any" }
  | { type: "count"; n: number }
  | { type: "all" };

/** Behavior when deadline expires. */
export type OnExpireBehavior = "fail_closed" | "keep_open";

/**
 * Route configuration for one approval kind.
 *
 * Invariants:
 * - approvers must be non-empty (zero_approvers_forbidden)
 * - quorum.n cannot exceed approvers.length (unreachable_quorum)
 * - account kind approvers must be owner/admin role
 * - AI members cannot be approvers
 * - decision kind uses tier sub-routes (T1/T2/T3)
 */
export interface ApprovalKindRoute {
  kind: ApprovalKind;
  approverUserIds: string[];
  quorum: ApprovalKindQuorum;
  finalGoUserId?: string | null;
  deadlineHours?: number | null;
  onExpire: OnExpireBehavior;
  remindEveryDays: number;
  notifyChannelIds?: string[];
}

/**
 * Decision tier identifier.
 * Can be any org-defined string (e.g. "T1", "T2", "T3", "board", "general_meeting").
 * Common values: T1 (専決), T2 (理事過半数), T3 (社員総会)
 */
export type DecisionTier = string;

/**
 * Legacy fixed tiers for backward compatibility.
 * New code should use tier ids from config.
 */
export const LEGACY_DECISION_TIERS = ["T1", "T2", "T3"] as const;
export type LegacyDecisionTier = (typeof LEGACY_DECISION_TIERS)[number];

/**
 * Decision tier route configuration.
 * Each tier has its own approval workflow settings.
 */
export interface DecisionTierRoute {
  /** Unique tier identifier (e.g. "T1", "board_approval") */
  tier: DecisionTier;
  /** Display name in Japanese */
  nameJa: string;
  /** Ordering rank (higher = more escalated). Must be unique within org. */
  rank?: number;
  /** Approver user IDs for this tier */
  approverUserIds: string[];
  /** Optional voter weights for weighted voting */
  voterWeights?: Record<string, number>;
  /** Quorum rule for approval */
  quorum: ApprovalKindQuorum;
  /** Optional final approval user */
  finalGoUserId?: string | null;
  /** Deadline in hours (null = no deadline) */
  deadlineHours?: number | null;
  /** Behavior when deadline expires */
  onExpire: OnExpireBehavior;
  /** Reminder interval in days */
  remindEveryDays: number;
}

/**
 * Tier routing rule for auto-escalation.
 * Rules are evaluated in order (highest tier first).
 */
export interface TierRoutingRule {
  /** Target tier id */
  tierId: DecisionTier;
  /** Match conditions (all must match for rule to apply) */
  match: TierMatchCondition;
}

/**
 * Match conditions for tier routing.
 * Multiple conditions are AND-ed together.
 */
export interface TierMatchCondition {
  /** Match if text contains any of these keywords (plain substring, case-insensitive) */
  keywords?: string[];
  /** Match if tax-excluded amount >= this value */
  minAmountJpy?: number;
  /** Match if category equals any of these values */
  categories?: string[];
}

/**
 * Topic gate configuration for post kind.
 * Determines which posts can skip approval.
 */
export interface TopicGateConfig {
  enabled: boolean;
  sensitiveTopics: string[];
  mainBoardChannelIds: string[];
}

/**
 * Decision workflow configuration.
 */
export interface DecisionWorkflowConfig {
  /** Tax-excluded amount threshold for legacy T2 escalation (deprecated, use tierRouting) */
  amountThresholdJpy: number;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  /** Consumption tax rate (default 0.10 = 10%). Must be between 0 and 1. */
  consumptionTaxRate?: number;
  deputyUserId?: string | null;
  /** Tier configurations (must have at least one) */
  tiers: DecisionTierRoute[];
  /**
   * Tier routing rules for auto-escalation.
   * Evaluated in order from first to last. First matching rule wins.
   * If no rule matches, defaultTierId is used.
   */
  tierRouting?: TierRoutingRule[];
  /** Default tier when no routing rule matches (defaults to first tier by rank) */
  defaultTierId?: DecisionTier;
}

/**
 * Org-level approval kind routes policy.
 */
export interface OrgApprovalKindRoutesPolicy {
  version: 1;
  policyId: string;
  policyName: string;
  routes: ApprovalKindRoute[];
  topicGate?: TopicGateConfig;
  decisionWorkflow?: DecisionWorkflowConfig;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Per-employee override for approval kind routes.
 */
export interface EmployeeApprovalKindRoutesOverride {
  employeeId: string;
  routes: Partial<Record<ApprovalKind, Partial<ApprovalKindRoute>>>;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Effective approval route for a specific kind.
 */
export interface EffectiveApprovalKindRoute {
  route: ApprovalKindRoute;
  source: "org" | "employee" | "default";
  orgRoute: ApprovalKindRoute | null;
  employeeOverride: Partial<ApprovalKindRoute> | null;
}
