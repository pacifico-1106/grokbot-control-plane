/**
 * F7 stuck watch item aggregation for Admin MCP list/inspect.
 */
import { listApprovals } from "@/lib/data";
import { isMentionWakeAudit, listAuditEventsForStuckWatch } from "@/lib/data/audit";
import { getOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import {
  hasSuccessfulReplyAfterWake,
  inferW1BlockingContext,
  w1ItemId,
} from "@/lib/stuck-watch/w1-mention-unanswered";
import {
  evaluateW2Eligibility,
  isApprovedUnfulfilled,
} from "@/lib/stuck-watch/w2-unfulfilled";
import type {
  AuditEvent,
  ApprovalRequest,
  FaultClass,
  StuckHint,
  StuckWatchItem,
  StuckWatchKind,
} from "@/lib/types";

function stuckWatchStateFromAudits(audits: AuditEvent[]) {
  const resolved = new Map<string, string>();
  const notified = new Map<string, string>();
  for (const audit of audits) {
    const itemId =
      typeof audit.metadata?.itemId === "string" ? audit.metadata.itemId : "";
    if (!itemId) continue;
    if (audit.action === "stuck_watch.resolve") {
      resolved.set(itemId, audit.createdAt);
    }
    if (audit.action === "stuck_watch.w1_notify") {
      notified.set(itemId, audit.createdAt);
    }
  }
  return { resolved, notified };
}

function w2ItemId(approvalId: string): string {
  return `w2:${approvalId}`;
}

function summarizeW1Ja(
  wake: AuditEvent,
  blocking: { faultClass: FaultClass; code: string }
): string {
  const channel = String(wake.metadata?.channel || "—");
  return `W1 メンション未返信: channel=${channel} / faultClass=${blocking.faultClass} / code=${blocking.code}`;
}

function nextStepW1Ja(faultClass: FaultClass): string {
  if (faultClass === "expected_gate") {
    return "正当ゲート（承認待ち等）のため自動再発火しません。承認を進めるか stuckWatch.resolve で解決済みにしてください。";
  }
  if (faultClass === "config_drift") {
    return "設定不足（台帳・スコープ等）です。parties.upsert / internalAudienceRule.patch で修正後、stuckWatch.retry を検討してください。";
  }
  return "ops_fault です。stuckWatch.retry で再試行できます（ゲートは再評価されます）。notifyMouth 通知も確認してください。";
}

function summarizeW2Ja(approval: ApprovalRequest): string {
  return `W2 承認後未fulfill: ${approval.tool} / jobId=${approval.jobId} / approvalId=${approval.id.slice(0, 8)}`;
}

function nextStepW2Ja(faultClass: FaultClass = "ops_fault"): string {
  if (faultClass === "expected_gate") {
    return "正当ゲートのため自動再発火しません。";
  }
  return "stuckWatch.retry で fulfill 再実行できます（最大2回・既存 #53 パス）。";
}

function buildW1Item(
  wake: AuditEvent,
  audits: AuditEvent[],
  approvals: ApprovalRequest[],
  policyMinutes: number,
  resolved: Map<string, string>,
  notified: Map<string, string>,
  now: Date
): StuckWatchItem | null {
  const channel = String(wake.metadata?.channel || "");
  const ts = String(wake.metadata?.ts || "");
  if (!channel || !ts) return null;
  const itemId = w1ItemId(channel, ts);
  const blocking = inferW1BlockingContext(wake, audits, approvals);
  if (hasSuccessfulReplyAfterWake(wake, audits, approvals)) return null;
  const wakeTime = new Date(wake.createdAt);
  const minutesOpen = Math.max(0, (now.getTime() - wakeTime.getTime()) / 60_000);
  if (minutesOpen < policyMinutes) return null;

  const resolvedAt = resolved.get(itemId);
  const notifiedAt = notified.get(itemId);
  const status = resolvedAt ? "resolved" : notifiedAt ? "notified" : "open";

  return {
    id: itemId,
    orgId: wake.orgId,
    kind: "w1_mention_unanswered",
    employeeId: wake.employeeId,
    jobId: blocking.jobId,
    approvalId: blocking.approvalId,
    tool: blocking.tool,
    faultClass: blocking.faultClass,
    stuckHint: blocking.stuckHint,
    code: blocking.code,
    status,
    detectedAt: wake.createdAt,
    notifiedAt: notifiedAt ?? null,
    resolvedAt: resolvedAt ?? null,
    minutesOpen: Math.floor(minutesOpen),
    summaryJa: summarizeW1Ja(wake, blocking),
    nextStepJa: nextStepW1Ja(blocking.faultClass),
    metadata: {
      channel,
      mentionTs: ts,
      threadTs: wake.metadata?.thread_ts,
      eventId: wake.metadata?.eventId,
      wakeAction: wake.action,
    },
  };
}

function buildW2Item(
  approval: ApprovalRequest,
  policy: { approvedUnfulfilledMinutes: number; maxAutoRetries: number; enabled: boolean },
  resolved: Map<string, string>,
  now: Date
): StuckWatchItem | null {
  if (!isApprovedUnfulfilled(approval)) return null;
  const eligibility = evaluateW2Eligibility({
    approval,
    policy: {
      version: 1,
      enabled: policy.enabled,
      mentionUnansweredMinutes: 15,
      approvedUnfulfilledMinutes: policy.approvedUnfulfilledMinutes,
      maxAutoRetries: policy.maxAutoRetries,
      retryBackoffSeconds: 60,
      autoRetryFaultClasses: ["ops_fault"],
      inferInternalAudienceFromLedger: true,
      updatedAt: now.toISOString(),
      updatedBy: "system",
    },
    now,
  });
  const itemId = w2ItemId(approval.id);
  const resolvedAt = resolved.get(itemId);
  const minutesOpen = approval.resolvedAt
    ? Math.max(
        0,
        (now.getTime() - new Date(approval.resolvedAt).getTime()) / 60_000
      )
    : 0;
  if (!resolvedAt && !eligibility.eligible && eligibility.reason === "too_soon") {
    return null;
  }

  const status = resolvedAt ? "resolved" : "open";
  const faultClass: FaultClass = "ops_fault";
  const stuckHint: StuckHint = "retryable";

  return {
    id: itemId,
    orgId: approval.orgId,
    kind: "w2_approved_unfulfilled",
    employeeId: approval.employeeId,
    jobId: approval.jobId,
    approvalId: approval.id,
    tool: approval.tool,
    faultClass,
    stuckHint,
    code: "approved_unfulfilled",
    status,
    detectedAt: approval.resolvedAt || approval.createdAt,
    notifiedAt: null,
    resolvedAt: resolvedAt ?? null,
    minutesOpen: Math.floor(minutesOpen),
    summaryJa: summarizeW2Ja(approval),
    nextStepJa: nextStepW2Ja(faultClass),
    metadata: {
      retryCount: eligibility.retryCount,
      w2Eligible: eligibility.eligible,
      w2Reason: eligibility.reason,
    },
  };
}

export async function listStuckWatchItems(
  orgId: string,
  options?: { includeResolved?: boolean }
): Promise<StuckWatchItem[]> {
  const policy = await getOrgStuckWatchPolicy(orgId);
  const audits = await listAuditEventsForStuckWatch(orgId, 500);
  const approvals = await listApprovals(orgId);
  const { resolved, notified } = stuckWatchStateFromAudits(audits);
  const now = new Date();
  const items: StuckWatchItem[] = [];

  for (const wake of audits) {
    if (!isMentionWakeAudit(wake)) continue;
    const item = buildW1Item(
      wake,
      audits,
      approvals,
      policy.mentionUnansweredMinutes,
      resolved,
      notified,
      now
    );
    if (!item) continue;
    if (!options?.includeResolved && item.status === "resolved") continue;
    items.push(item);
  }

  for (const approval of approvals) {
    const item = buildW2Item(
      approval,
      policy,
      resolved,
      now
    );
    if (!item) continue;
    if (!options?.includeResolved && item.status === "resolved") continue;
    items.push(item);
  }

  return items.sort(
    (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
  );
}

export async function getStuckWatchItem(
  orgId: string,
  itemId: string
): Promise<StuckWatchItem | null> {
  const items = await listStuckWatchItems(orgId, { includeResolved: true });
  return items.find((item) => item.id === itemId) ?? null;
}

export function stuckWatchKindFromItemId(itemId: string): StuckWatchKind | null {
  if (itemId.startsWith("w1:")) return "w1_mention_unanswered";
  if (itemId.startsWith("w2:")) return "w2_approved_unfulfilled";
  return null;
}
