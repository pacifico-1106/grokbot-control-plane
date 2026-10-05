/**
 * P1 Decision Workflow — Decision Expiry Cron Handler
 *
 * Called from stuck-watch cron to handle expired decisions.
 * Supports any tier with a deadline and onExpire setting.
 *
 * Security:
 * - fail_closed: Any error results in rejection, never approval
 * - Tier's onExpire setting determines behavior:
 *   - fail_closed: Auto-reject on expiry
 *   - keep_open: Keep pending (no auto-action)
 * - Legacy T2 records without deadlineAt use creation + 72h as implicit deadline
 *   (for backward compatibility with records created before config-based deadlines)
 * - Idempotent: Already rejected/approved decisions are skipped
 * - Only active when P1_DECISION_WORKFLOW_ENABLED is ON
 */

import { isDecisionWorkflowEnabled, isMcpEventsEnabled } from "@/lib/feature-flags";
import { listApprovals, resolveApproval } from "@/lib/data/approvals";
import { appendAuditEvent } from "@/lib/data/audit";
import { getOrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/data";
import type { OnExpireBehavior, DecisionTierRoute } from "@/lib/approval-kind-routes/types";
import type { ApprovalRequest } from "@/lib/types";

/**
 * Legacy T2 deadline hours.
 * Only used for backward compatibility with T2 records created before
 * config-based deadlines were introduced. New records use tier.deadlineHours.
 */
const LEGACY_T2_DEADLINE_HOURS = 72;

export interface DecisionExpiryCheckResult {
  approvalId: string;
  tier: string;
  action: "rejected" | "skipped" | "error";
  reason: string;
  error?: string;
}

export interface RunDecisionExpiryCronResult {
  ok: boolean;
  processed: number;
  rejected: number;
  skipped: number;
  errors: number;
  results: DecisionExpiryCheckResult[];
}

/**
 * Check if approval is a decision request with a deadline.
 */
function isDecisionWithDeadline(approval: ApprovalRequest): boolean {
  const metadata = approval.metadata as Record<string, unknown> | null;
  if (metadata?.type !== "decision_request") return false;
  if (approval.status !== "pending") return false;

  // Has explicit deadlineAt
  if (metadata.deadlineAt) return true;

  // Legacy T2 records without deadlineAt (use creation + 72h)
  if (metadata.tier === "T2") return true;

  return false;
}

/**
 * Get the effective deadline for a decision.
 * Returns null if no deadline applies.
 */
function getEffectiveDeadline(approval: ApprovalRequest): Date | null {
  const metadata = approval.metadata as Record<string, unknown> | null;
  const deadlineAt = metadata?.deadlineAt;

  // Explicit deadlineAt from metadata
  if (deadlineAt && typeof deadlineAt === "string") {
    const deadline = new Date(deadlineAt);
    if (!isNaN(deadline.getTime())) {
      return deadline;
    }
  }

  // Legacy fallback: T2 without deadlineAt uses creation + 72h
  if (metadata?.tier === "T2") {
    return new Date(
      new Date(approval.createdAt).getTime() + LEGACY_T2_DEADLINE_HOURS * 60 * 60 * 1000
    );
  }

  return null;
}

/**
 * Get the tier route configuration for a decision.
 */
async function getTierRouteForDecision(
  approval: ApprovalRequest
): Promise<DecisionTierRoute | null> {
  const metadata = approval.metadata as Record<string, unknown> | null;
  const tier = metadata?.tier as string | undefined;
  if (!tier) return null;

  const orgPolicy = await getOrgApprovalKindRoutesPolicy(approval.orgId);
  const config = orgPolicy?.decisionWorkflow;
  if (!config?.tiers) return null;

  return config.tiers.find((t) => t.tier === tier) ?? null;
}

/**
 * Get the onExpire behavior for a decision.
 * Defaults to fail_closed for safety.
 */
async function getOnExpireBehavior(
  approval: ApprovalRequest
): Promise<OnExpireBehavior> {
  const tierRoute = await getTierRouteForDecision(approval);

  // If tier route exists, use its onExpire setting
  if (tierRoute) {
    return tierRoute.onExpire;
  }

  // Legacy T2 default: fail_closed
  const metadata = approval.metadata as Record<string, unknown> | null;
  if (metadata?.tier === "T2") {
    return "fail_closed";
  }

  // Default: fail_closed for safety
  return "fail_closed";
}

/**
 * Process expiry for a single decision.
 */
async function processDecisionExpiry(
  approval: ApprovalRequest,
  now: Date
): Promise<DecisionExpiryCheckResult> {
  const metadata = approval.metadata as Record<string, unknown> | null;
  const tier = (metadata?.tier as string) || "unknown";

  if (!isDecisionWorkflowEnabled()) {
    return {
      approvalId: approval.id,
      tier,
      action: "skipped",
      reason: "decision_workflow_disabled",
    };
  }

  if (approval.status !== "pending") {
    return {
      approvalId: approval.id,
      tier,
      action: "skipped",
      reason: `already_${approval.status}`,
    };
  }

  const deadline = getEffectiveDeadline(approval);
  if (!deadline) {
    return {
      approvalId: approval.id,
      tier,
      action: "skipped",
      reason: "no_deadline",
    };
  }

  if (now <= deadline) {
    return {
      approvalId: approval.id,
      tier,
      action: "skipped",
      reason: "not_expired",
    };
  }

  // Check onExpire behavior
  const onExpire = await getOnExpireBehavior(approval);
  if (onExpire === "keep_open") {
    return {
      approvalId: approval.id,
      tier,
      action: "skipped",
      reason: "on_expire_keep_open",
    };
  }

  // onExpire === "fail_closed": auto-reject
  try {
    const resolved = await resolveApproval(
      approval.id,
      "rejected",
      `system:${tier.toLowerCase()}_expiry`,
      approval.orgId
    );

    if (!resolved) {
      return {
        approvalId: approval.id,
        tier,
        action: "skipped",
        reason: "already_resolved",
      };
    }

    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId: approval.employeeId,
      credentialId: approval.credentialId,
      action: "decision.expired",
      purpose: approval.purpose,
      summary: `${tier}決裁依頼が期限切れで自動却下されました: ${approval.title}`,
      metadata: {
        approvalId: approval.id,
        tier,
        deadlineAt: deadline.toISOString(),
        expiredAt: now.toISOString(),
        hoursOverdue: Math.floor(
          (now.getTime() - deadline.getTime()) / (1000 * 60 * 60)
        ),
        onExpire,
      },
    });

    // MCP Events (flag OFF → nothing): a decision deadline that auto-rejects is
    // reported as approval.expired (status rejected, reason deadline_exceeded).
    if (isMcpEventsEnabled()) {
      try {
        const { emitApprovalEvent } = await import("@/lib/mcp-events/service");
        await emitApprovalEvent({ approval: resolved, name: "approval.expired", reason: "deadline_exceeded" });
      } catch {
        // best-effort
      }
    }

    return {
      approvalId: approval.id,
      tier,
      action: "rejected",
      reason: "deadline_exceeded",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown_error";

    // fail_closed: log error but still count as error (will be retried)
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId: approval.employeeId,
      credentialId: approval.credentialId,
      action: "decision.expired",
      purpose: approval.purpose,
      summary: `${tier}決裁の期限切れ処理でエラー発生（fail_closed: 却下扱い）`,
      metadata: {
        approvalId: approval.id,
        tier,
        error: errorMessage,
        failClosed: true,
      },
    });

    return {
      approvalId: approval.id,
      tier,
      action: "error",
      reason: "expiry_processing_error",
      error: errorMessage,
    };
  }
}

/**
 * Run decision expiry check for all pending decisions with deadlines in an org.
 * Called from stuck-watch cron.
 */
export async function runDecisionExpiryCron(
  orgId: string,
  now: Date = new Date()
): Promise<RunDecisionExpiryCronResult> {
  if (!isDecisionWorkflowEnabled()) {
    return {
      ok: true,
      processed: 0,
      rejected: 0,
      skipped: 0,
      errors: 0,
      results: [],
    };
  }

  const approvals = await listApprovals(orgId);
  const decisionsWithDeadline = approvals.filter(isDecisionWithDeadline);

  const results: DecisionExpiryCheckResult[] = [];

  for (const approval of decisionsWithDeadline) {
    const result = await processDecisionExpiry(approval, now);
    results.push(result);
  }

  return {
    ok: true,
    processed: results.length,
    rejected: results.filter((r) => r.action === "rejected").length,
    skipped: results.filter((r) => r.action === "skipped").length,
    errors: results.filter((r) => r.action === "error").length,
    results,
  };
}

/**
 * Check and process expiry for a single decision.
 * Used by stuck-watch item handler.
 */
export async function checkAndExpireDecision(
  approval: ApprovalRequest,
  now: Date = new Date()
): Promise<DecisionExpiryCheckResult> {
  return processDecisionExpiry(approval, now);
}

// Backward-compatible aliases for T2-specific functions
export type T2ExpiryCheckResult = DecisionExpiryCheckResult;
export type RunT2ExpiryCronResult = RunDecisionExpiryCronResult;

/**
 * @deprecated Use runDecisionExpiryCron instead.
 */
export const runT2ExpiryCron = runDecisionExpiryCron;

/**
 * @deprecated Use checkAndExpireDecision instead.
 */
export const checkAndExpireT2Decision = checkAndExpireDecision;
