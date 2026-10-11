import { assertApprovalExecutionAuthority } from "@/lib/approvals/execution-authority";
/**
 * W2: approved-but-unfulfilled watch — auto reinvoke fulfill (max 2).
 * Uses existing fulfillApprovedInvoke / fulfillApprovedAdmin paths only.
 */
import { fulfillApprovedInvoke } from "@/lib/approvals/fulfill";
import { parseFulfillment, parseInvokeSnapshot } from "@/lib/approvals/fulfill";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import type { FulfillmentFileUpload } from "@/lib/approvals/attachment-upload-claim";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { appendAuditEvent, updateApprovalMetadata } from "@/lib/data";
import { getOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import type {
  ApprovalRequest,
  ApprovalStuckWatchMeta,
  OrgStuckWatchPolicy,
} from "@/lib/types";

/**
 * Tools W2 must never re-run on its own, even with retries left: a re-run
 * ticket of these runs only when an admin agent explicitly re-invokes the tool
 * with its approvalId. W2 still tracks them (stuck-watch item, stuckHint
 * "fix", reason manual_reinvoke_required) but never fulfills them — neither
 * the cron nor stuckWatch.retry.
 *
 * - employees.postingIdentity.set: switching the Slack posting identity changes
 *   what the other side sees, so a person must know when it happens (木村).
 * - money tools (木村 2026-10-09 round 3): a W2 re-run re-verifies the stored
 *   approver and re-executes with the same jobId — it does NOT go through the
 *   approval gates again — so spend limits, plan changes, card links and
 *   orders are re-run only by an explicit re-invoke.
 */
const W2_MONEY_TOOLS = [
  "employees.spend.set",
  "plan.upgrade",
  "cardSetup.mintLink",
  "cardSetup.mintPortalLink",
  "commerce.order",
] as const;

export const W2_MANUAL_REINVOKE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "employees.postingIdentity.set",
  ...W2_MONEY_TOOLS,
]);

function approvalToolName(approval: ApprovalRequest): string {
  return String(approval.metadata?.adminTool || approval.tool || "").trim();
}

/** The tool name when W2 must leave this approval to an explicit re-invoke, else null. */
export function w2ManualReinvokeOnlyTool(approval: ApprovalRequest): string | null {
  const tool = approvalToolName(approval);
  return W2_MANUAL_REINVOKE_ONLY_TOOLS.has(tool) ? tool : null;
}

export function w2ManualReinvokeNextStepJa(tool: string): string {
  const why = (W2_MONEY_TOOLS as readonly string[]).includes(tool) ? "お金に関わる操作のため" : "相手に見える名義が変わるため";
  const who = tool === "commerce.order" ? "AI社員" : "管理エージェント"; // commerce.order is a gateway invoke, not an admin tool
  return `自動再実行の対象外です（${why}）。原因を直してから、${who}が ${tool} を approvalId 付きで呼び直してください（その時点ですべて確認し直します）。`;
}

function parseStuckWatchMeta(
  metadata: Record<string, unknown> | null | undefined
): ApprovalStuckWatchMeta {
  const raw = metadata?.stuckWatch;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const rec = raw as ApprovalStuckWatchMeta;
  const w2 = rec.w2;
  if (!w2 || typeof w2 !== "object") {
    return {};
  }
  return {
    w2: {
      firstDetectedAt:
        typeof w2.firstDetectedAt === "string" ? w2.firstDetectedAt : undefined,
      lastAttemptAt:
        typeof w2.lastAttemptAt === "string" ? w2.lastAttemptAt : undefined,
      retryCount:
        typeof w2.retryCount === "number" && Number.isFinite(w2.retryCount)
          ? Math.max(0, Math.floor(w2.retryCount))
          : 0,
    },
  };
}

export function isApprovedUnfulfilled(approval: ApprovalRequest): boolean {
  if (approval.status !== "approved") return false;
  const fulfillment = parseFulfillment(approval.metadata);
  if (fulfillment?.ok) return false;

  if (isAdminClassApproval(approval)) {
    const adminFulfillment =
      approval.metadata?.adminFulfillment ?? approval.metadata?.fulfillment;
    if (
      adminFulfillment &&
      typeof adminFulfillment === "object" &&
      (adminFulfillment as { ok?: boolean }).ok === true
    ) {
      return false;
    }
    return true;
  }

  const snapshot = parseInvokeSnapshot(approval.metadata);
  if (!snapshot) return false;
  return !fulfillment?.ok;
}

export type W2EligibilityInput = {
  approval: ApprovalRequest;
  policy: OrgStuckWatchPolicy;
  now: Date;
};

export type W2EligibilityResult = {
  eligible: boolean;
  reason?:
    | "disabled"
    | "not_unfulfilled"
    | "too_soon"
    | "max_retries"
    | "backoff"
    | "manual_reinvoke_required";
  retryCount: number;
  minutesSinceResolved: number;
};

export function evaluateW2Eligibility(
  input: W2EligibilityInput
): W2EligibilityResult {
  const { approval, policy, now } = input;
  const meta = parseStuckWatchMeta(approval.metadata);
  const retryCount = meta.w2?.retryCount ?? 0;

  if (!policy.enabled) {
    return { eligible: false, reason: "disabled", retryCount, minutesSinceResolved: 0 };
  }

  if (!isApprovedUnfulfilled(approval)) {
    return {
      eligible: false,
      reason: "not_unfulfilled",
      retryCount,
      minutesSinceResolved: 0,
    };
  }

  if (w2ManualReinvokeOnlyTool(approval)) {
    return {
      eligible: false,
      reason: "manual_reinvoke_required",
      retryCount,
      minutesSinceResolved: 0,
    };
  }

  if (retryCount >= policy.maxAutoRetries) {
    return {
      eligible: false,
      reason: "max_retries",
      retryCount,
      minutesSinceResolved: 0,
    };
  }

  const resolvedAt = approval.resolvedAt
    ? new Date(approval.resolvedAt)
    : null;
  const firstDetected = meta.w2?.firstDetectedAt
    ? new Date(meta.w2.firstDetectedAt)
    : resolvedAt;
  const anchor = firstDetected && !Number.isNaN(firstDetected.getTime())
    ? firstDetected
    : now;
  const minutesSinceResolved = Math.max(
    0,
    (now.getTime() - anchor.getTime()) / 60_000
  );

  if (minutesSinceResolved < policy.approvedUnfulfilledMinutes) {
    return {
      eligible: false,
      reason: "too_soon",
      retryCount,
      minutesSinceResolved,
    };
  }

  const lastAttempt = meta.w2?.lastAttemptAt
    ? new Date(meta.w2.lastAttemptAt)
    : null;
  if (
    lastAttempt &&
    !Number.isNaN(lastAttempt.getTime()) &&
    now.getTime() - lastAttempt.getTime() <
      policy.retryBackoffSeconds * 1000
  ) {
    return {
      eligible: false,
      reason: "backoff",
      retryCount,
      minutesSinceResolved,
    };
  }

  return { eligible: true, retryCount, minutesSinceResolved };
}

async function persistW2Meta(
  approval: ApprovalRequest,
  patch: ApprovalStuckWatchMeta["w2"]
): Promise<ApprovalRequest> {
  const current = parseStuckWatchMeta(approval.metadata);
  const nextMeta = {
    ...approval.metadata,
    stuckWatch: {
      ...((approval.metadata?.stuckWatch as Record<string, unknown>) ?? {}),
      w2: {
        ...current.w2,
        ...patch,
      },
    },
  };
  const saved = await updateApprovalMetadata(approval, nextMeta);
  if (saved) {
    approval.metadata = saved.metadata;
    return saved;
  }
  approval.metadata = nextMeta;
  return approval;
}

/**
 * Stamp W2 watch metadata when fulfill did not complete after approval.
 */
export async function stampW2WatchIfUnfulfilled(
  approval: ApprovalRequest
): Promise<void> {
  if (!isApprovedUnfulfilled(approval)) return;
  const now = new Date().toISOString();
  const meta = parseStuckWatchMeta(approval.metadata);
  if (meta.w2?.firstDetectedAt) return;
  await persistW2Meta(approval, {
    firstDetectedAt: now,
    retryCount: meta.w2?.retryCount ?? 0,
  });
}

export type W2RetryResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  retryCount: number;
  fulfillmentOk?: boolean;
  /** Approved attachment: W2 posts the approved text only (not_sent / rerun_required). */
  fileUpload?: FulfillmentFileUpload;
};

/**
 * Run one W2 fulfill retry via existing #53 fulfill paths (same jobId, idempotent).
 */
export async function runW2FulfillRetry(
  approval: ApprovalRequest,
  policy?: OrgStuckWatchPolicy
): Promise<W2RetryResult> {
  const effectivePolicy =
    policy ?? (await getOrgStuckWatchPolicy(approval.orgId));
  const eligibility = evaluateW2Eligibility({
    approval,
    policy: effectivePolicy,
    now: new Date(),
  });

  if (!eligibility.eligible) {
    return {
      ok: false,
      skipped: true,
      reason: eligibility.reason,
      retryCount: eligibility.retryCount,
    };
  }

  try { await assertApprovalExecutionAuthority(approval); }
  catch { return { ok: false, skipped: true, reason: "approval_authority_revoked", retryCount: eligibility.retryCount }; }
  const nextRetryCount = eligibility.retryCount + 1;
  const now = new Date().toISOString();
  await persistW2Meta(approval, {
    firstDetectedAt:
      parseStuckWatchMeta(approval.metadata).w2?.firstDetectedAt ?? now,
    lastAttemptAt: now,
    retryCount: nextRetryCount,
  });

  let fulfillmentOk = false;
  let fileUpload: FulfillmentFileUpload | undefined;
  if (isAdminClassApproval(approval)) {
    const admin = await fulfillApprovedAdmin(approval);
    fulfillmentOk = admin?.ok === true;
  } else {
    const invoke = await fulfillApprovedInvoke(approval);
    fulfillmentOk = invoke?.ok === true;
    fileUpload = invoke?.fileUpload;
  }

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action: "stuck_watch.w2_retry",
    purpose: approval.purpose,
    summary: fulfillmentOk
      ? "W2: 承認後未fulfillを自動再実行（成功）"
      : "W2: 承認後未fulfillを自動再実行（未完了）",
    metadata: {
      approvalId: approval.id,
      jobId: approval.jobId,
      tool: approval.tool,
      retryCount: nextRetryCount,
      fulfillmentOk,
      faultClass: "ops_fault",
      nextAction: fulfillmentOk ? "resolved" : "retry_or_escalate",
    },
  }).catch(() => undefined);

  return {
    ok: fulfillmentOk,
    retryCount: nextRetryCount,
    fulfillmentOk,
    ...(fileUpload ? { fileUpload } : {}),
  };
}

export async function processW2RetriesForApprovals(
  approvals: ApprovalRequest[]
): Promise<W2RetryResult[]> {
  const results: W2RetryResult[] = [];
  for (const approval of approvals) {
    if (!isApprovedUnfulfilled(approval)) continue;
    const policy = await getOrgStuckWatchPolicy(approval.orgId);
    const eligibility = evaluateW2Eligibility({
      approval,
      policy,
      now: new Date(),
    });
    if (!eligibility.eligible) continue;
    results.push(await runW2FulfillRetry(approval, policy));
  }
  return results;
}
