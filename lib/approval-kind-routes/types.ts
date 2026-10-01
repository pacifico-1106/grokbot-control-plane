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
 * Decision tier sub-routes (T1/T2/T3).
 * Only used when kind = "decision".
 */
export type DecisionTier = "T1" | "T2" | "T3";

export interface DecisionTierRoute {
  tier: DecisionTier;
  nameJa: string;
  approverUserIds: string[];
  voterWeights?: Record<string, number>;
  quorum: ApprovalKindQuorum;
  finalGoUserId?: string | null;
  deadlineHours?: number | null;
  onExpire: OnExpireBehavior;
  remindEveryDays: number;
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
  amountThresholdJpy: number;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  /** Consumption tax rate (default 0.10 = 10%). Must be between 0 and 1. */
  consumptionTaxRate?: number;
  deputyUserId?: string | null;
  tiers: DecisionTierRoute[];
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
