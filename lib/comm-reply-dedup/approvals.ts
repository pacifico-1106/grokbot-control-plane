/**
 * Pending conversation approvals that must never go out late
 * (COMM_REPLY_DEDUP_ENABLED; callers check the flag):
 * - supersede: a newer reply was sent / a newer approval was requested for the
 *   same conversation (same org + employee + conversation key)
 * - expire: older than COMM_REPLY_APPROVAL_TTL_MINUTES (default 24 h)
 * Closing is conditional on the current status, so a concurrent approve wins
 * the race and is then re-checked at fulfill (lib/comm-reply-dedup/guard.ts).
 */
import type { ApprovalRequest } from "@/lib/types";
import { appendAuditEvent } from "@/lib/data/audit";
import { closeApprovalWithoutSend, listPendingApprovalsForTools } from "@/lib/data/approvals";
import { audienceGatedToolIds } from "@/lib/gateway/tools";
import { parseInvokeSnapshot } from "@/lib/approvals/fulfill";
import { commReplyDedupNow, commReplyDedupSettings, resolveCommReplyDedupKey } from "./config";
import { conversationKey, conversationKeyInputFromSnapshot } from "./conversation-key";

export type SupersedeReason = "newer_reply_sent" | "newer_approval_requested" | "replied_after_approval";

/** Conversation key of an approval (from its invoke snapshot), or null. */
export function approvalConversationKey(approval: ApprovalRequest, key: Buffer): string | null {
  const snapshot = parseInvokeSnapshot(approval.metadata);
  if (!snapshot) return null;
  const input = conversationKeyInputFromSnapshot(snapshot, approval.orgId);
  return input ? conversationKey(input, key) : null;
}

export async function auditApprovalClosed(
  approval: ApprovalRequest,
  action: "approval.superseded" | "approval.expired",
  meta: Record<string, unknown>
): Promise<void> {
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action,
    purpose: approval.purpose,
    summary:
      action === "approval.superseded"
        ? "会話承認を置き換え済みとして送信せずに終了（同じ会話で新しい返信 / 承認依頼あり）"
        : "会話承認を期限切れとして送信せずに終了",
    metadata: { approvalId: approval.id, tool: approval.tool, jobId: approval.jobId, ...meta },
  }).catch(() => undefined);
}

export async function supersedePendingConversationApprovals(input: {
  orgId: string;
  employeeId: string;
  conversationKey: string;
  reason: "newer_reply_sent" | "newer_approval_requested";
  excludeApprovalId?: string | null;
  supersededBy?: string | null;
}): Promise<string[]> {
  const key = resolveCommReplyDedupKey();
  if (!key) return [];
  let pending: ApprovalRequest[] = [];
  try {
    pending = await listPendingApprovalsForTools({
      orgId: input.orgId,
      employeeId: input.employeeId,
      tools: audienceGatedToolIds(),
      limit: 200,
    });
  } catch {
    return [];
  }
  const closed: string[] = [];
  for (const approval of pending) {
    if (approval.id === input.excludeApprovalId) continue;
    if (approvalConversationKey(approval, key) !== input.conversationKey) continue;
    const meta = {
      reason: input.reason,
      supersededBy: input.supersededBy ?? null,
      conversationKeyPrefix: input.conversationKey.slice(0, 12),
      phase: "invoke",
    };
    const done = await closeApprovalWithoutSend({ approval, from: ["pending"], to: "superseded", meta }).catch(() => null);
    if (!done) continue;
    closed.push(approval.id);
    await auditApprovalClosed(approval, "approval.superseded", meta);
  }
  return closed;
}

export function conversationApprovalExpiresAtMs(approval: Pick<ApprovalRequest, "createdAt">): number {
  const created = Date.parse(approval.createdAt);
  if (!Number.isFinite(created)) return Number.POSITIVE_INFINITY;
  return created + commReplyDedupSettings().approvalTtlMinutes * 60_000;
}

export async function expireStaleConversationApprovals(input: {
  orgId?: string | null;
  employeeId?: string | null;
  phase: "invoke" | "sweep";
}): Promise<string[]> {
  const ttlMinutes = commReplyDedupSettings().approvalTtlMinutes;
  const cutoffIso = new Date(commReplyDedupNow() - ttlMinutes * 60_000).toISOString();
  let stale: ApprovalRequest[] = [];
  try {
    stale = await listPendingApprovalsForTools({
      orgId: input.orgId ?? null,
      employeeId: input.employeeId ?? null,
      tools: audienceGatedToolIds(),
      createdBeforeIso: cutoffIso,
      limit: input.phase === "sweep" ? 500 : 50,
    });
  } catch {
    return [];
  }
  const closed: string[] = [];
  for (const approval of stale) {
    const meta = { reason: "approval_ttl_elapsed", ttlMinutes, createdAt: approval.createdAt, phase: input.phase };
    const done = await closeApprovalWithoutSend({ approval, from: ["pending"], to: "expired", meta }).catch(() => null);
    if (!done) continue;
    closed.push(approval.id);
    await auditApprovalClosed(approval, "approval.expired", meta);
  }
  return closed;
}
