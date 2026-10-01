/**
 * P1 Decision Workflow — T2 Expiry Cron Handler
 *
 * Called from stuck-watch cron to auto-reject expired T2 decisions.
 *
 * Security:
 * - fail_closed: Any error results in rejection, never approval
 * - T2 without deadlineAt uses creation + 72h as implicit deadline
 * - Idempotent: Already rejected/approved decisions are skipped
 * - Only active when P1_DECISION_WORKFLOW_ENABLED is ON
 */

import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";
import { listApprovals, resolveApproval } from "@/lib/data/approvals";
import { appendAuditEvent } from "@/lib/data/audit";
import type { ApprovalRequest } from "@/lib/types";

const T2_DEADLINE_HOURS = 72;

export interface T2ExpiryCheckResult {
  approvalId: string;
  action: "rejected" | "skipped" | "error";
  reason: string;
  error?: string;
}

export interface RunT2ExpiryCronResult {
  ok: boolean;
  processed: number;
  rejected: number;
  skipped: number;
  errors: number;
  results: T2ExpiryCheckResult[];
}

function isT2DecisionApproval(approval: ApprovalRequest): boolean {
  const metadata = approval.metadata as Record<string, unknown> | null;
  return (
    metadata?.type === "decision_request" &&
    metadata?.tier === "T2" &&
    approval.status === "pending"
  );
}

function getEffectiveDeadline(approval: ApprovalRequest): Date {
  const metadata = approval.metadata as Record<string, unknown> | null;
  const deadlineAt = metadata?.deadlineAt;

  if (deadlineAt && typeof deadlineAt === "string") {
    return new Date(deadlineAt);
  }

  return new Date(
    new Date(approval.createdAt).getTime() + T2_DEADLINE_HOURS * 60 * 60 * 1000
  );
}

async function expireT2Decision(
  approval: ApprovalRequest,
  now: Date
): Promise<T2ExpiryCheckResult> {
  if (!isDecisionWorkflowEnabled()) {
    return {
      approvalId: approval.id,
      action: "skipped",
      reason: "decision_workflow_disabled",
    };
  }

  if (approval.status !== "pending") {
    return {
      approvalId: approval.id,
      action: "skipped",
      reason: `already_${approval.status}`,
    };
  }

  const metadata = approval.metadata as Record<string, unknown> | null;
  if (metadata?.tier !== "T2") {
    return {
      approvalId: approval.id,
      action: "skipped",
      reason: "not_t2",
    };
  }

  const deadline = getEffectiveDeadline(approval);

  if (now <= deadline) {
    return {
      approvalId: approval.id,
      action: "skipped",
      reason: "not_expired",
    };
  }

  try {
    const resolved = await resolveApproval(
      approval.id,
      "rejected",
      "system:t2_expiry",
      approval.orgId
    );

    if (!resolved) {
      return {
        approvalId: approval.id,
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
      summary: `T2決裁依頼が期限切れで自動却下されました: ${approval.title}`,
      metadata: {
        approvalId: approval.id,
        tier: "T2",
        deadlineAt: deadline.toISOString(),
        expiredAt: now.toISOString(),
        hoursOverdue: Math.floor(
          (now.getTime() - deadline.getTime()) / (1000 * 60 * 60)
        ),
      },
    });

    return {
      approvalId: approval.id,
      action: "rejected",
      reason: "deadline_exceeded",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown_error";

    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId: approval.employeeId,
      credentialId: approval.credentialId,
      action: "decision.expired",
      purpose: approval.purpose,
      summary: `T2決裁の期限切れ処理でエラー発生（fail_closed: 却下扱い）`,
      metadata: {
        approvalId: approval.id,
        tier: "T2",
        error: errorMessage,
        failClosed: true,
      },
    });

    return {
      approvalId: approval.id,
      action: "error",
      reason: "expiry_processing_error",
      error: errorMessage,
    };
  }
}

/**
 * Run T2 expiry check for all pending T2 decisions in an org.
 * Called from stuck-watch cron.
 */
export async function runT2ExpiryCron(
  orgId: string,
  now: Date = new Date()
): Promise<RunT2ExpiryCronResult> {
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
  const t2Decisions = approvals.filter(isT2DecisionApproval);

  const results: T2ExpiryCheckResult[] = [];

  for (const approval of t2Decisions) {
    const result = await expireT2Decision(approval, now);
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
 * Check and expire a single T2 decision.
 * Used by stuck-watch item handler.
 */
export async function checkAndExpireT2Decision(
  approval: ApprovalRequest,
  now: Date = new Date()
): Promise<T2ExpiryCheckResult> {
  return expireT2Decision(approval, now);
}
