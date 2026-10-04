/**
 * Duplicate-reply prevention orchestration (COMM_REPLY_DEDUP_ENABLED).
 * Used by gateway invoke (lib/gateway/invoke.ts) and approval fulfill
 * (lib/approvals/fulfill.ts). Channel-independent: the conversation key is
 * built from surface + destination (+ thread), never from Slack specifics.
 *
 * Fail closed: flag ON but no HMAC key / ledger unavailable → nothing is sent.
 * Logs and audit rows carry only hash prefixes, match kind, similarity and
 * lengths — never the body.
 */
import type { ApprovalRequest, GatewayInvokeRequest } from "@/lib/types";
import type { InvokeSnapshot } from "@/lib/approvals/fulfill";
import { isCommReplyDedupEnabled } from "@/lib/feature-flags";
import { isAudienceGatedTool } from "@/lib/gateway/tools";
import { appendAuditEvent } from "@/lib/data/audit";
import { closeApprovalWithoutSend } from "@/lib/data/approvals";
import {
  claimCommReplySend,
  findRecentCommReplyDuplicate,
  finishCommReplySend,
  type CommReplyDuplicate,
} from "@/lib/data/comm-reply-sends";
import { fingerprintReplyBody, type ReplyFingerprint } from "./fingerprint";
import {
  commReplyDedupNow,
  commReplyDedupSettings,
  commReplyLedgerRetentionSeconds,
  resolveCommReplyDedupKey,
  type CommReplyDedupSettings,
} from "./config";
import {
  conversationKey,
  conversationKeyInputFromBody,
  conversationKeyInputFromSnapshot,
  type ConversationKeyInput,
} from "./conversation-key";
import {
  auditApprovalClosed,
  conversationApprovalExpiresAtMs,
  supersedePendingConversationApprovals,
} from "./approvals";

export const DUPLICATE_REPLY_SUPPRESSED = "duplicate_reply_suppressed";
export const DUPLICATE_CHECK_UNAVAILABLE = "duplicate_check_unavailable";
export const APPROVAL_SUPERSEDED = "approval_superseded";
export const APPROVAL_EXPIRED = "approval_expired";
export const FULFILL_BLOCKED_DEDUP_UNAVAILABLE = "fulfill_blocked_dedup_unavailable";

export const DUPLICATE_REPLY_SUPPRESSED_MESSAGE_JA =
  "同じ会話に同じ内容（または言い換えただけの内容）を直前に送信済みのため、送信しませんでした。";
export const DUPLICATE_CHECK_UNAVAILABLE_MESSAGE_JA =
  "重複送信チェックが利用できないため、送信を止めました（fail-closed）。";

export type PreparedCommReplyDedup =
  | { kind: "off" }
  | { kind: "skip" }
  | { kind: "unavailable"; reason: string }
  | {
      kind: "ready";
      orgId: string;
      employeeId: string;
      conversationKey: string;
      fingerprint: ReplyFingerprint;
      settings: CommReplyDedupSettings;
    };

function prepare(orgId: string, employeeId: string, input: ConversationKeyInput | null, text: string): PreparedCommReplyDedup {
  if (!isCommReplyDedupEnabled()) return { kind: "off" };
  if (!orgId || !employeeId) return { kind: "unavailable", reason: "scope_missing" };
  const key = resolveCommReplyDedupKey();
  if (!key) return { kind: "unavailable", reason: "dedup_key_missing" };
  const convKey = input ? conversationKey(input, key) : null;
  if (!convKey) return { kind: "skip" };
  const settings = commReplyDedupSettings();
  return {
    kind: "ready",
    orgId,
    employeeId,
    conversationKey: convKey,
    fingerprint: fingerprintReplyBody(text, key, settings.minSimilarityChars),
    settings,
  };
}

export function prepareCommReplyDedupFromBody(input: {
  orgId: string;
  employeeId: string;
  body: GatewayInvokeRequest;
  text: string;
}): PreparedCommReplyDedup {
  if (!isCommReplyDedupEnabled()) return { kind: "off" };
  return prepare(input.orgId, input.employeeId, conversationKeyInputFromBody(input.body, input.orgId), input.text);
}

function threshold(settings: CommReplyDedupSettings): number | null {
  return settings.mode === "similar" ? settings.similarityThreshold : null;
}

/** Hash-only audit metadata for a prepared send. */
export function dedupAuditMeta(prepared: Extract<PreparedCommReplyDedup, { kind: "ready" }>): Record<string, unknown> {
  return {
    conversationKeyPrefix: prepared.conversationKey.slice(0, 12),
    bodyHashPrefix: prepared.fingerprint.bodyHash.slice(0, 12),
    normalizedLength: prepared.fingerprint.normalizedLength,
    windowMinutes: prepared.settings.windowMinutes,
    mode: prepared.settings.mode,
  };
}

type AuditCtx = {
  orgId: string;
  employeeId: string | null;
  credentialId: string | null;
  purpose: string | null;
  tool: string;
  jobId: string | null;
  approvalId?: string | null;
  phase: "invoke" | "approval.fulfill";
};

export async function auditDuplicateSuppressed(
  ctx: AuditCtx,
  prepared: Extract<PreparedCommReplyDedup, { kind: "ready" }>,
  dup: CommReplyDuplicate
): Promise<void> {
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId,
    action: "comm_reply.duplicate_suppressed",
    purpose: ctx.purpose,
    summary: `${ctx.tool} を重複送信として停止（同じ会話に同一 / 類似の本文を送信済み）`,
    metadata: {
      tool: ctx.tool,
      jobId: ctx.jobId,
      code: DUPLICATE_REPLY_SUPPRESSED,
      match: dup.match,
      similarity: Math.round(dup.similarity * 1000) / 1000,
      matchedAt: dup.matchedAt,
      phase: ctx.phase,
      ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
      ...dedupAuditMeta(prepared),
    },
  }).catch(() => undefined);
}

export async function auditDedupUnavailable(ctx: AuditCtx, reason: string): Promise<void> {
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId,
    action: "comm_reply.dedup_unavailable",
    purpose: ctx.purpose,
    summary: `${ctx.tool} を重複チェック不可のため停止（fail-closed）`,
    metadata: {
      tool: ctx.tool,
      jobId: ctx.jobId,
      code: ctx.phase === "invoke" ? DUPLICATE_CHECK_UNAVAILABLE : FULFILL_BLOCKED_DEDUP_UNAVAILABLE,
      reason,
      phase: ctx.phase,
      ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
    },
  }).catch(() => undefined);
}

/** Invoke, before approval gates: read-only. */
export async function precheckCommReplyDuplicate(
  prepared: PreparedCommReplyDedup
): Promise<{ state: "none" } | CommReplyDuplicate | { state: "unavailable"; reason: string }> {
  if (prepared.kind === "off" || prepared.kind === "skip") return { state: "none" };
  if (prepared.kind === "unavailable") return { state: "unavailable", reason: prepared.reason };
  return findRecentCommReplyDuplicate({
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    bodyHash: prepared.fingerprint.bodyHash,
    sketch: prepared.fingerprint.sketch,
    windowSeconds: prepared.settings.windowMinutes * 60,
    similarityThreshold: threshold(prepared.settings),
  });
}

export type DirectSendClaim =
  | { state: "none" }
  | { state: "claimed"; id: string }
  | CommReplyDuplicate
  | { state: "unavailable"; reason: string };

/** Invoke, right before a live post: atomic claim (concurrent identical sends → one wins). */
export async function claimDirectCommReplySend(prepared: PreparedCommReplyDedup, tool: string): Promise<DirectSendClaim> {
  if (prepared.kind === "off" || prepared.kind === "skip") return { state: "none" };
  if (prepared.kind === "unavailable") return { state: "unavailable", reason: prepared.reason };
  const res = await claimCommReplySend({
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    bodyHash: prepared.fingerprint.bodyHash,
    sketch: prepared.fingerprint.sketch,
    tool,
    windowSeconds: prepared.settings.windowMinutes * 60,
    similarityThreshold: threshold(prepared.settings),
    retentionSeconds: commReplyLedgerRetentionSeconds(prepared.settings),
  });
  if (res.state === "claimed" || res.state === "duplicate" || res.state === "unavailable") return res;
  return { state: "unavailable", reason: res.state === "denied" ? "claim_denied" : "claim_failed" };
}

/** After the post: failed releases the claim; sent supersedes pending approvals for the conversation. */
export async function finishDirectCommReplySend(
  prepared: PreparedCommReplyDedup,
  claimId: string | null,
  outcome: "sent" | "failed" | "uncertain",
  opts: { jobId?: string | null } = {}
): Promise<void> {
  if (prepared.kind !== "ready" || !claimId) return;
  await finishCommReplySend({ id: claimId, orgId: prepared.orgId, outcome });
  if (outcome === "failed") return;
  await supersedePendingConversationApprovals({
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    reason: "newer_reply_sent",
    supersededBy: opts.jobId ? `job:${opts.jobId}` : null,
  }).catch(() => []);
}

/** Invoke, after a new conversation approval was queued: older pending ones for the conversation close. */
export async function supersedeOlderOnNewApproval(
  prepared: PreparedCommReplyDedup,
  newApprovalId: string | null | undefined
): Promise<string[]> {
  if (prepared.kind !== "ready" || !newApprovalId) return [];
  return supersedePendingConversationApprovals({
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    reason: "newer_approval_requested",
    excludeApprovalId: newApprovalId,
    supersededBy: newApprovalId,
  }).catch(() => []);
}

export type FulfillDedupGate =
  | { ok: true; claimId: string | null; prepared: PreparedCommReplyDedup }
  | { ok: false; code: string };

async function closeAtFulfill(
  approval: ApprovalRequest,
  to: "superseded" | "expired",
  meta: Record<string, unknown>
): Promise<void> {
  const closed = await closeApprovalWithoutSend({ approval, from: ["approved"], to, meta }).catch(() => null);
  // The caller's copy must not look approved any more (W2 stamp / re-runs skip it).
  approval.status = to;
  if (closed) approval.metadata = closed.metadata;
  await auditApprovalClosed(approval, to === "superseded" ? "approval.superseded" : "approval.expired", meta);
}

/**
 * Approval fulfill, inside the execution claim and before the post:
 * 1. expired (created + TTL < now) → closed as expired, nothing sent
 * 2. a reply was already sent to the conversation after the approval was
 *    created (or the same body within the window) → closed as superseded
 * 3. otherwise the send is claimed in the ledger (finish with fulfillDedupFinish)
 */
export async function fulfillDedupGate(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot,
  text: string
): Promise<FulfillDedupGate> {
  const off: FulfillDedupGate = { ok: true, claimId: null, prepared: { kind: "off" } };
  if (!isCommReplyDedupEnabled()) return off;
  const tool = snapshot.tool || approval.tool || "";
  if (!isAudienceGatedTool(tool)) return off;
  const ctx: AuditCtx = {
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    purpose: approval.purpose,
    tool,
    jobId: snapshot.jobId || approval.jobId || null,
    approvalId: approval.id,
    phase: "approval.fulfill",
  };

  const expiresAt = conversationApprovalExpiresAtMs(approval);
  if (commReplyDedupNow() > expiresAt) {
    await closeAtFulfill(approval, "expired", {
      reason: "approval_ttl_elapsed",
      ttlMinutes: commReplyDedupSettings().approvalTtlMinutes,
      createdAt: approval.createdAt,
      phase: "approval.fulfill",
    });
    return { ok: false, code: APPROVAL_EXPIRED };
  }

  const employeeId = snapshot.employeeId || approval.employeeId || "";
  const prepared = prepare(approval.orgId, employeeId, conversationKeyInputFromSnapshot(snapshot, approval.orgId), text);
  if (prepared.kind === "skip" || prepared.kind === "off") return { ok: true, claimId: null, prepared };
  if (prepared.kind === "unavailable") {
    await auditDedupUnavailable(ctx, prepared.reason);
    return { ok: false, code: FULFILL_BLOCKED_DEDUP_UNAVAILABLE };
  }
  const res = await claimCommReplySend({
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    bodyHash: prepared.fingerprint.bodyHash,
    sketch: prepared.fingerprint.sketch,
    tool,
    approvalId: approval.id,
    approvalCreatedAt: approval.createdAt,
    windowSeconds: prepared.settings.windowMinutes * 60,
    similarityThreshold: threshold(prepared.settings),
    retentionSeconds: commReplyLedgerRetentionSeconds(prepared.settings),
  });
  if (res.state === "claimed") return { ok: true, claimId: res.id, prepared };
  if (res.state === "superseded" || res.state === "duplicate") {
    const meta = {
      reason: res.state === "superseded" ? "replied_after_approval" : "duplicate_of_recent_reply",
      ...(res.state === "superseded"
        ? { repliedAt: res.repliedAt }
        : { match: res.match, similarity: Math.round(res.similarity * 1000) / 1000, matchedAt: res.matchedAt }),
      phase: "approval.fulfill",
      ...dedupAuditMeta(prepared),
    };
    await closeAtFulfill(approval, "superseded", meta);
    return { ok: false, code: APPROVAL_SUPERSEDED };
  }
  await auditDedupUnavailable(ctx, res.state === "denied" ? "claim_denied" : res.reason);
  return { ok: false, code: FULFILL_BLOCKED_DEDUP_UNAVAILABLE };
}

/** After the fulfill post. Sent → also supersede other pending approvals for the conversation. */
export async function fulfillDedupFinish(
  gate: FulfillDedupGate,
  approval: ApprovalRequest,
  outcome: "sent" | "failed" | "uncertain"
): Promise<void> {
  if (!gate.ok || gate.prepared.kind !== "ready" || !gate.claimId) return;
  await finishCommReplySend({ id: gate.claimId, orgId: gate.prepared.orgId, outcome });
  if (outcome === "failed") return;
  await supersedePendingConversationApprovals({
    orgId: gate.prepared.orgId,
    employeeId: gate.prepared.employeeId,
    conversationKey: gate.prepared.conversationKey,
    reason: "newer_reply_sent",
    excludeApprovalId: approval.id,
    supersededBy: approval.id,
  }).catch(() => []);
}
