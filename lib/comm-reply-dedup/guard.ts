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
import { createHmac } from "node:crypto";
import { isCommReplyDedupEnabled, isDuplicateGuardV2Enabled } from "@/lib/feature-flags";
import { isAudienceGatedTool } from "@/lib/gateway/tools";
import { appendAuditEvent } from "@/lib/data/audit";
import { closeApprovalWithoutSend } from "@/lib/data/approvals";
import {
  claimCommReplySend,
  claimOutboundSendV2,
  findCrossEmployeeDuplicateV1,
  findRecentCommReplyDuplicate,
  finishCommReplySend,
  releaseUncertainOutboundSend,
  type CommReplyDuplicate,
  type CrossEmployeeWarning,
  type DuplicateScope,
  type OutboundClaimV2Input,
  type OutboundClaimV2Result,
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
  channelKey,
  conversationKey,
  conversationKeyInputFromBody,
  conversationKeyInputFromSnapshot,
  snsConversationKeyInput,
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
/** v2: an earlier matching post has an unknown outcome (may have gone out). */
export const DUPLICATE_POST_UNCERTAIN = "duplicate_post_uncertain";
/** v2: this post's outcome is unknown (timeout / 5xx after submit); the row is kept. */
export const POST_OUTCOME_UNKNOWN = "post_outcome_unknown";
/** Another employee posted the same content to the same conversation / channel. */
export const CROSS_EMPLOYEE_DUPLICATE = "cross_employee_duplicate";

export const DUPLICATE_REPLY_SUPPRESSED_MESSAGE_JA =
  "同じ会話に同じ内容（または言い換えただけの内容）を直前に送信済みのため、送信しませんでした。";
export const DUPLICATE_CHECK_UNAVAILABLE_MESSAGE_JA =
  "重複送信チェックが利用できないため、送信を止めました（fail-closed）。";
export const DUPLICATE_POST_UNCERTAIN_MESSAGE_JA =
  "同じ内容の直前の投稿が届いたかどうか確認できていないため、送信しませんでした。";
export const POST_OUTCOME_UNKNOWN_MESSAGE_JA =
  "投稿の結果を確認できませんでした（タイムアウト / 相手側の応答なし）。投稿されている可能性があります。";

/** What the AI should do next (machine-readable). */
export type DedupNextAction = "none" | "retry_later" | "verify_then_confirm";

export const NEXT_STEP_DUPLICATE =
  "Do not resend. The same (or a trivially different) message was already posted here. If something new must be said, write it as a new message with the new content.";
export const NEXT_STEP_UNAVAILABLE =
  "Nothing was posted. The duplicate check store is unavailable; retry the same request later (it is safe to retry).";
export function nextStepVerify(ref: string | null): string {
  return ref
    ? `The earlier post may have been delivered. Check whether the message already exists in the conversation first. If it is there, do not resend. Only if you confirmed it is NOT there, resend once with duplicateGuard: { confirmedNotDelivered: "${ref}" } (staffpass_invoke: inside payload).`
    : "An earlier identical post (possibly by another employee) may have been delivered. Check whether the message already exists in the conversation; do not resend it blindly.";
}

export type SendTier = "short" | "long";

/**
 * (4) Short bodies (normalized length < minSimilarityChars, e.g. "OK" / "了解です")
 * are compared exactly (after v2 normalization), only within the same
 * conversation / thread, only within the short window, never across employees.
 */
export function sendTierOf(fp: Pick<ReplyFingerprint, "normalizedLength">, minChars = 20): SendTier {
  return fp.normalizedLength < minChars ? "short" : "long";
}

/**
 * (5) A failed post keeps its ledger row unless the provider confirmed it never
 * went out (adapters set sendState "not_sent"). Anything else — "unknown" or no
 * classification at all — is kept as uncertain (fail closed).
 */
export function failedPostOutcome(result: { ok: boolean; error?: string; sendState?: string }): "failed" | "uncertain" {
  return result.sendState === "not_sent" ? "failed" : "uncertain";
}

/** The ledger outcome after a post: v1 keeps its rule (failed releases). */
export function ledgerOutcomeAfterPost(
  prepared: PreparedCommReplyDedup,
  result: { ok: boolean; sendState?: string }
): "sent" | "failed" | "uncertain" {
  if (result.ok) return "sent";
  return prepared.kind === "ready" && prepared.settings.v2 ? failedPostOutcome(result) : "failed";
}

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
      /** v2 only (null under v1): channel-level key (no thread), job key. */
      channelKey: string | null;
      jobKey: string | null;
      tier: SendTier;
      /** v2 file upload: exact only, separate HMAC domain. */
      upload?: boolean;
    };

function jobKeyOf(key: Buffer, orgId: string, employeeId: string, jobId: string | null | undefined): string | null {
  const job = (jobId ?? "").trim();
  if (!job) return null;
  return createHmac("sha256", key).update(["job", "v1", orgId, employeeId, job].join("\u0000")).digest("hex");
}

function prepare(
  orgId: string,
  employeeId: string,
  input: ConversationKeyInput | null,
  text: string,
  jobId?: string | null
): PreparedCommReplyDedup {
  if (!isCommReplyDedupEnabled()) return { kind: "off" };
  if (!orgId || !employeeId) return { kind: "unavailable", reason: "scope_missing" };
  const key = resolveCommReplyDedupKey();
  if (!key) return { kind: "unavailable", reason: "dedup_key_missing" };
  const convKey = input ? conversationKey(input, key) : null;
  if (!convKey) return { kind: "skip" };
  const settings = commReplyDedupSettings();
  const fingerprint = fingerprintReplyBody(text, key, settings.minSimilarityChars, settings.v2 ? 2 : 1);
  return {
    kind: "ready",
    orgId,
    employeeId,
    conversationKey: convKey,
    fingerprint,
    settings,
    channelKey: settings.v2 && input ? (channelKey(input, key) ?? convKey) : null,
    jobKey: settings.v2 ? jobKeyOf(key, orgId, employeeId, jobId) : null,
    tier: sendTierOf(fingerprint, settings.minSimilarityChars),
  };
}

export function prepareCommReplyDedupFromBody(input: {
  orgId: string;
  employeeId: string;
  body: GatewayInvokeRequest;
  text: string;
}): PreparedCommReplyDedup {
  if (!isCommReplyDedupEnabled()) return { kind: "off" };
  return prepare(input.orgId, input.employeeId, conversationKeyInputFromBody(input.body, input.orgId), input.text, input.body.jobId);
}

/** (6) sns.publish (v2 only): the employee's own account on that medium is the conversation. */
export function prepareSnsPublishDedup(input: {
  orgId: string;
  employeeId: string;
  surface: string | null;
  text: string;
  jobId?: string | null;
}): PreparedCommReplyDedup {
  if (!isDuplicateGuardV2Enabled()) return { kind: "off" };
  if (!input.surface) return { kind: "skip" };
  return prepare(input.orgId, input.employeeId, snsConversationKeyInput(input.orgId, input.employeeId, input.surface), input.text, input.jobId);
}

/**
 * (6) File upload with a message (v2 only): fingerprint = keyed hash of the file
 * identity (keyed hash of reference + filename) and the normalized comment, in
 * its own "upload:" domain with no sketch — so it only ever matches the same
 * file + comment shared to the same place, never a text post.
 */
export function prepareFileUploadDedup(
  base: PreparedCommReplyDedup,
  file: { fileRef?: unknown; filename?: unknown; initialComment?: unknown }
): PreparedCommReplyDedup {
  if (base.kind !== "ready" || !base.settings.v2) return base.kind === "ready" ? { kind: "off" } : base;
  const key = resolveCommReplyDedupKey();
  if (!key) return { kind: "unavailable", reason: "dedup_key_missing" };
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const identity = createHmac("sha256", key).update(["file", str(file.fileRef), str(file.filename)].join("\u0000")).digest("hex");
  const comment = fingerprintReplyBody(str(file.initialComment), key, base.settings.minSimilarityChars, 2);
  const bodyHash = createHmac("sha256", key).update(`upload:${identity}:${comment.bodyHash}`).digest("hex");
  return {
    ...base,
    fingerprint: { bodyHash, sketch: null, normalizedLength: comment.normalizedLength },
    tier: "long",
    upload: true,
  };
}

function threshold(settings: CommReplyDedupSettings): number | null {
  return settings.mode === "similar" ? settings.similarityThreshold : null;
}

type Ready = Extract<PreparedCommReplyDedup, { kind: "ready" }>;

/** The window that applies to this send (short bodies use the short window under v2). */
export function effectiveWindowMinutes(prepared: Ready): number {
  return prepared.settings.v2 && prepared.tier === "short" ? prepared.settings.shortWindowMinutes : prepared.settings.windowMinutes;
}

/** Hash-only audit metadata for a prepared send. */
export function dedupAuditMeta(prepared: Ready): Record<string, unknown> {
  return {
    conversationKeyPrefix: prepared.conversationKey.slice(0, 12),
    bodyHashPrefix: prepared.fingerprint.bodyHash.slice(0, 12),
    normalizedLength: prepared.fingerprint.normalizedLength,
    windowMinutes: effectiveWindowMinutes(prepared),
    mode: prepared.settings.mode,
    ...(prepared.settings.v2
      ? {
          guard: "v2",
          tier: prepared.tier,
          ...(prepared.channelKey ? { channelKeyPrefix: prepared.channelKey.slice(0, 12) } : {}),
          jobKeyed: Boolean(prepared.jobKey),
          ...(prepared.upload ? { upload: true } : {}),
        }
      : {}),
  };
}

export type DedupAuditCtx = AuditCtx;
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

/** v1 duplicate or v2 duplicate (scope / matched state). */
export type GuardDuplicate = CommReplyDuplicate & {
  scope?: DuplicateScope;
  matchedState?: "reserved" | "sent" | "uncertain";
  matchedId?: string;
};

export async function auditDuplicateSuppressed(ctx: AuditCtx, prepared: Ready, dup: GuardDuplicate): Promise<void> {
  const uncertain = dup.matchedState === "uncertain";
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId,
    action: "comm_reply.duplicate_suppressed",
    purpose: ctx.purpose,
    summary: uncertain
      ? `${ctx.tool} を停止（同じ内容の直前の投稿が届いたか未確認）`
      : `${ctx.tool} を重複送信として停止（同じ会話に同一 / 類似の本文を送信済み）`,
    metadata: {
      tool: ctx.tool,
      jobId: ctx.jobId,
      code: uncertain ? DUPLICATE_POST_UNCERTAIN : DUPLICATE_REPLY_SUPPRESSED,
      match: dup.match,
      similarity: Math.round(dup.similarity * 1000) / 1000,
      matchedAt: dup.matchedAt,
      ...(dup.scope ? { scope: dup.scope } : {}),
      ...(dup.matchedState ? { matchedState: dup.matchedState } : {}),
      phase: ctx.phase,
      ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
      ...dedupAuditMeta(prepared),
    },
  }).catch(() => undefined);
  if (dup.scope === "cross_employee") {
    await auditCrossEmployee(ctx, prepared, "block", {
      scope: "cross_employee",
      match: dup.match,
      similarity: dup.similarity,
      matchedAt: dup.matchedAt,
    });
  }
}

/** (3) Another employee's same post: warn (posted) or block. Hashes only; never the other row's id. */
export async function auditCrossEmployee(
  ctx: AuditCtx,
  prepared: Ready,
  decision: "warn" | "block",
  warning: CrossEmployeeWarning
): Promise<void> {
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId,
    action: "comm_reply.cross_employee_duplicate",
    purpose: ctx.purpose,
    summary:
      decision === "block"
        ? `${ctx.tool} を停止（別の AI 社員が同じ会話に同じ内容を送信済み）`
        : `${ctx.tool} を送信（別の AI 社員が同じ会話に同じ内容を送信済み: 警告のみ）`,
    metadata: {
      tool: ctx.tool,
      jobId: ctx.jobId,
      code: CROSS_EMPLOYEE_DUPLICATE,
      decision,
      match: warning.match,
      similarity: Math.round(warning.similarity * 1000) / 1000,
      matchedAt: warning.matchedAt,
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

export async function auditPostOutcomeUnknown(ctx: AuditCtx, prepared: PreparedCommReplyDedup, claimId: string): Promise<void> {
  if (prepared.kind !== "ready") return;
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId,
    action: "comm_reply.post_outcome_unknown",
    purpose: ctx.purpose,
    summary: `${ctx.tool} の投稿結果が不明（記録を残し、確認なしの再送を止める）`,
    metadata: {
      tool: ctx.tool,
      jobId: ctx.jobId,
      code: POST_OUTCOME_UNKNOWN,
      uncertainRef: claimId,
      phase: ctx.phase,
      ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
      ...dedupAuditMeta(prepared),
    },
  }).catch(() => undefined);
}

function v2ClaimInput(
  prepared: Ready,
  tool: string,
  opts: { approvalId?: string | null; approvalCreatedAt?: string | null; dryRun: boolean }
): OutboundClaimV2Input {
  const s = prepared.settings;
  const short = prepared.tier === "short";
  return {
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    channelKey: prepared.channelKey ?? prepared.conversationKey,
    jobKey: prepared.jobKey,
    bodyHash: prepared.fingerprint.bodyHash,
    sketch: short ? null : prepared.fingerprint.sketch,
    tool,
    approvalId: opts.approvalId ?? null,
    approvalCreatedAt: opts.approvalCreatedAt ?? null,
    windowSeconds: effectiveWindowMinutes(prepared) * 60,
    similarityThreshold: short ? null : threshold(s),
    retentionSeconds: commReplyLedgerRetentionSeconds(s),
    // Short bodies: same thread only, never across employees ("OK" is not a duplicate of someone else's "OK").
    crossThread: short ? false : s.crossThread,
    crossEmployee: short ? "off" : s.crossEmployee,
    dryRun: opts.dryRun,
  };
}

export type GuardCheck =
  | { state: "none"; warning?: CrossEmployeeWarning }
  | GuardDuplicate
  | { state: "unavailable"; reason: string };

function fromV2(res: OutboundClaimV2Result): GuardCheck | { state: "claimed"; id: string; warning?: CrossEmployeeWarning } {
  switch (res.state) {
    case "none":
    case "claimed":
    case "duplicate":
    case "unavailable":
      return res;
    case "denied":
      return { state: "unavailable", reason: "claim_denied" };
    default:
      return { state: "unavailable", reason: "claim_failed" };
  }
}

/** Invoke, before approval gates: read-only (v1 direct select; v2 RPC dry run). */
export async function precheckCommReplyDuplicate(prepared: PreparedCommReplyDedup, tool = "comm.reply"): Promise<GuardCheck> {
  if (prepared.kind === "off" || prepared.kind === "skip") return { state: "none" };
  if (prepared.kind === "unavailable") return { state: "unavailable", reason: prepared.reason };
  if (prepared.settings.v2) {
    const res = fromV2(await claimOutboundSendV2(v2ClaimInput(prepared, tool, { dryRun: true })));
    return res.state === "claimed" ? { state: "none", ...(res.warning ? { warning: res.warning } : {}) } : res;
  }
  const dup = await findRecentCommReplyDuplicate({
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    bodyHash: prepared.fingerprint.bodyHash,
    sketch: prepared.fingerprint.sketch,
    windowSeconds: prepared.settings.windowMinutes * 60,
    similarityThreshold: threshold(prepared.settings),
  });
  if (dup.state !== "none") return dup;
  // (3) v1: warn only, long bodies only, best effort (an error here never blocks:
  // the v1 ledger check above already passed fail-closed).
  if (prepared.tier === "long") {
    const warning = await findCrossEmployeeDuplicateV1({
      orgId: prepared.orgId,
      employeeId: prepared.employeeId,
      conversationKey: prepared.conversationKey,
      bodyHash: prepared.fingerprint.bodyHash,
      sketch: prepared.fingerprint.sketch,
      windowSeconds: prepared.settings.windowMinutes * 60,
      similarityThreshold: threshold(prepared.settings),
    }).catch(() => null);
    if (warning) return { state: "none", warning };
  }
  return { state: "none" };
}

/**
 * (5) The AI verified that its earlier post with an unknown outcome is absent
 * and resends with duplicateGuard.confirmedNotDelivered = uncertainRef. Only an
 * uncertain row of the same org + employee is released; anything else is
 * ignored and the following claim still blocks.
 */
export async function releaseConfirmedUncertain(
  prepared: PreparedCommReplyDedup,
  ref: unknown,
  ctx: AuditCtx
): Promise<boolean> {
  if (prepared.kind !== "ready" || !prepared.settings.v2) return false;
  return releaseConfirmedUncertainForScope({ orgId: prepared.orgId, employeeId: prepared.employeeId }, ref, ctx, dedupAuditMeta(prepared));
}

/** Same, by org + employee (approved re-run: the snapshot is fulfilled, not the request body). */
export async function releaseConfirmedUncertainForScope(
  scope: { orgId: string; employeeId: string },
  ref: unknown,
  ctx: AuditCtx,
  meta: Record<string, unknown> = {}
): Promise<boolean> {
  if (!isDuplicateGuardV2Enabled() || typeof ref !== "string" || !ref.trim()) return false;
  const res = await releaseUncertainOutboundSend({ id: ref.trim(), orgId: scope.orgId, employeeId: scope.employeeId });
  if (!("released" in res) || !res.released) return false;
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId,
    action: "comm_reply.uncertain_released",
    purpose: ctx.purpose,
    summary: `${ctx.tool}: 結果不明だった投稿が届いていないことを AI が確認し、再送を 1 回許可`,
    metadata: {
      tool: ctx.tool,
      jobId: ctx.jobId,
      uncertainRef: ref.trim(),
      phase: ctx.phase,
      ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
      ...meta,
    },
  }).catch(() => undefined);
  return true;
}

/** duplicateGuard.confirmedNotDelivered from the request (top level, or args for MCP callers). */
export function confirmedNotDeliveredRef(body: GatewayInvokeRequest): string | null {
  const top = (body as { duplicateGuard?: { confirmedNotDelivered?: unknown } }).duplicateGuard;
  const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
  const fromArgs = args.duplicateGuard && typeof args.duplicateGuard === "object"
    ? (args.duplicateGuard as { confirmedNotDelivered?: unknown })
    : undefined;
  const raw = top?.confirmedNotDelivered ?? fromArgs?.confirmedNotDelivered;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export type DirectSendClaim =
  | { state: "none" }
  | { state: "claimed"; id: string; warning?: CrossEmployeeWarning }
  | GuardDuplicate
  | { state: "unavailable"; reason: string };

/** Invoke, right before a live post: atomic claim (concurrent identical sends → one wins). */
export async function claimDirectCommReplySend(prepared: PreparedCommReplyDedup, tool: string): Promise<DirectSendClaim> {
  if (prepared.kind === "off" || prepared.kind === "skip") return { state: "none" };
  if (prepared.kind === "unavailable") return { state: "unavailable", reason: prepared.reason };
  if (prepared.settings.v2) {
    const res = fromV2(await claimOutboundSendV2(v2ClaimInput(prepared, tool, { dryRun: false })));
    // A claim never answers "none"; treat it as a store fault (fail closed).
    return res.state === "none" ? { state: "unavailable", reason: "claim_failed" } : res;
  }
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

/**
 * Response body (and HTTP status) for a stop by the guard; null = go ahead.
 * Every stop carries code / reasonCode, nextAction and nextStep.
 */
export function dedupStopBody(
  check: GuardCheck | DirectSendClaim,
  prepared: PreparedCommReplyDedup
): { status: number; body: Record<string, unknown> } | null {
  if (check.state === "unavailable") {
    return {
      status: 503,
      body: {
        ok: false,
        code: DUPLICATE_CHECK_UNAVAILABLE,
        error: DUPLICATE_CHECK_UNAVAILABLE,
        reasonCode: DUPLICATE_CHECK_UNAVAILABLE,
        message: DUPLICATE_CHECK_UNAVAILABLE_MESSAGE_JA,
        retryable: true,
        nextAction: "retry_later" satisfies DedupNextAction,
        nextStep: NEXT_STEP_UNAVAILABLE,
      },
    };
  }
  if (check.state !== "duplicate" || prepared.kind !== "ready") return null;
  const dup = check as GuardDuplicate;
  const common = {
    ok: false,
    needs_approval: false,
    match: dup.match,
    similarity: Math.round(dup.similarity * 1000) / 1000,
    matchedAt: dup.matchedAt,
    windowMinutes: effectiveWindowMinutes(prepared),
    ...(dup.scope ? { scope: dup.scope } : {}),
    retryable: false,
  };
  if (dup.matchedState === "uncertain") {
    const ref = dup.matchedId ?? null;
    return {
      status: 409,
      body: {
        ...common,
        code: DUPLICATE_POST_UNCERTAIN,
        error: DUPLICATE_POST_UNCERTAIN,
        reasonCode: DUPLICATE_POST_UNCERTAIN,
        message: DUPLICATE_POST_UNCERTAIN_MESSAGE_JA,
        nextAction: "verify_then_confirm" satisfies DedupNextAction,
        nextStep: nextStepVerify(ref),
        ...(ref ? { uncertainRef: ref } : {}),
      },
    };
  }
  return {
    status: 409,
    body: {
      ...common,
      code: DUPLICATE_REPLY_SUPPRESSED,
      error: DUPLICATE_REPLY_SUPPRESSED,
      reasonCode: DUPLICATE_REPLY_SUPPRESSED,
      message: DUPLICATE_REPLY_SUPPRESSED_MESSAGE_JA,
      nextAction: "none" satisfies DedupNextAction,
      nextStep: NEXT_STEP_DUPLICATE,
    },
  };
}

/** (5) v2: the post's outcome is unknown; the ledger row stays (uncertain). */
export function postOutcomeUnknownBody(claimId: string | null, providerError?: string): Record<string, unknown> {
  return {
    ok: false,
    code: POST_OUTCOME_UNKNOWN,
    error: POST_OUTCOME_UNKNOWN,
    reasonCode: POST_OUTCOME_UNKNOWN,
    message: POST_OUTCOME_UNKNOWN_MESSAGE_JA,
    ...(providerError ? { providerError } : {}),
    retryable: false,
    nextAction: "verify_then_confirm" satisfies DedupNextAction,
    nextStep: nextStepVerify(claimId),
    ...(claimId ? { uncertainRef: claimId } : {}),
  };
}

/** (3) Warning object returned with a successful post (never blocks). */
export function duplicateWarningBody(warning: CrossEmployeeWarning): Record<string, unknown> {
  return {
    reasonCode: CROSS_EMPLOYEE_DUPLICATE,
    decision: "warn",
    scope: "cross_employee",
    match: warning.match,
    similarity: Math.round(warning.similarity * 1000) / 1000,
    matchedAt: warning.matchedAt,
    nextStep:
      "Another AI employee already posted the same content to this conversation. Check with that employee's job before posting this kind of message again.",
  };
}

/** After the post: failed releases the claim; sent supersedes pending approvals for the conversation with a similar body. */
export async function finishDirectCommReplySend(
  prepared: PreparedCommReplyDedup,
  claimId: string | null,
  outcome: "sent" | "failed" | "uncertain",
  opts: { jobId?: string | null } = {}
): Promise<void> {
  if (prepared.kind !== "ready" || !claimId) return;
  await finishCommReplySend({ id: claimId, orgId: prepared.orgId, outcome });
  if (outcome === "failed" || prepared.upload) return;
  await supersedePendingConversationApprovals({
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    fingerprint: prepared.fingerprint,
    settings: prepared.settings,
    reason: "newer_reply_sent",
    supersededBy: opts.jobId ? `job:${opts.jobId}` : null,
  }).catch(() => []);
}

/** Invoke, after a new conversation approval was queued: older pending ones for the conversation with a similar body close. */
export async function supersedeOlderOnNewApproval(
  prepared: PreparedCommReplyDedup,
  newApprovalId: string | null | undefined
): Promise<string[]> {
  if (prepared.kind !== "ready" || !newApprovalId) return [];
  return supersedePendingConversationApprovals({
    orgId: prepared.orgId,
    employeeId: prepared.employeeId,
    conversationKey: prepared.conversationKey,
    fingerprint: prepared.fingerprint,
    settings: prepared.settings,
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
  // Nothing is sent either way. Only a close that actually happened changes the
  // caller's copy (W2 stamp / re-runs then skip it) and is audited; when the
  // store refused or failed, the copy stays as stored (approved) and the next
  // fulfill re-checks and stops again.
  if (!closed) return;
  approval.status = to;
  approval.metadata = closed.metadata;
  await auditApprovalClosed(approval, to === "superseded" ? "approval.superseded" : "approval.expired", meta);
}

function snsSurfaceOfSnapshot(snapshot: InvokeSnapshot): string | null {
  const args = (snapshot.args ?? {}) as Record<string, unknown>;
  const raw = [args.surface, args.snsSurface, args.media].find((v) => typeof v === "string" && v.trim());
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v === "twitter" ? "x" : v;
}

/**
 * Approval fulfill, inside the execution claim and before the post:
 * 1. expired (created + TTL < now) → closed as expired, nothing sent
 * 2. a reply with the same / a similar body (same criterion as duplicates) was
 *    already sent to the conversation after the approval was created, or the
 *    same / a similar body within the window → closed as superseded. A reply
 *    about another matter does not stop it.
 *    v2: also the same jobId + body (any age), the channel (cross-thread), other
 *    employees (block mode), and a window that also reaches back from the
 *    approval's creation. An earlier matching post with an UNKNOWN outcome stops
 *    the send WITHOUT closing the approval (duplicate_post_uncertain).
 * 3. otherwise the send is claimed in the ledger (finish with fulfillDedupFinish)
 * Conversation tools (v1 + v2) and sns.publish (v2).
 */
export async function fulfillDedupGate(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot,
  text: string
): Promise<FulfillDedupGate> {
  const off: FulfillDedupGate = { ok: true, claimId: null, prepared: { kind: "off" } };
  if (!isCommReplyDedupEnabled()) return off;
  const tool = snapshot.tool || approval.tool || "";
  const sns = tool === "sns.publish";
  if (sns ? !isDuplicateGuardV2Enabled() : !isAudienceGatedTool(tool)) return off;
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

  // The conversation TTL is for conversation approvals only (an SNS post keeps its own approval lifetime).
  if (!sns) {
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
  }

  const employeeId = snapshot.employeeId || approval.employeeId || "";
  const prepared = sns
    ? prepareSnsPublishDedup({ orgId: approval.orgId, employeeId, surface: snsSurfaceOfSnapshot(snapshot), text, jobId: ctx.jobId })
    : prepare(approval.orgId, employeeId, conversationKeyInputFromSnapshot(snapshot, approval.orgId), text, ctx.jobId);
  if (prepared.kind === "skip" || prepared.kind === "off") return { ok: true, claimId: null, prepared };
  if (prepared.kind === "unavailable") {
    await auditDedupUnavailable(ctx, prepared.reason);
    return { ok: false, code: FULFILL_BLOCKED_DEDUP_UNAVAILABLE };
  }
  let res: OutboundClaimV2Result | Awaited<ReturnType<typeof claimCommReplySend>>;
  if (prepared.settings.v2) {
    res = await claimOutboundSendV2(
      v2ClaimInput(prepared, tool, { approvalId: approval.id, approvalCreatedAt: approval.createdAt, dryRun: false })
    );
  } else {
    res = await claimCommReplySend({
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
  }
  if (res.state === "claimed") {
    if ("warning" in res && res.warning) await auditCrossEmployee(ctx, prepared, "warn", res.warning);
    return { ok: true, claimId: res.id, prepared };
  }
  if (res.state === "duplicate" && (res as GuardDuplicate).matchedState === "uncertain") {
    // Possibly already delivered, not confirmed: do not send, do not close.
    await auditDuplicateSuppressed(ctx, prepared, res as GuardDuplicate);
    return { ok: false, code: DUPLICATE_POST_UNCERTAIN };
  }
  if (res.state === "superseded" || res.state === "duplicate") {
    const dup = res as GuardDuplicate;
    const meta = {
      reason: res.state === "superseded" ? "replied_after_approval" : "duplicate_of_recent_reply",
      match: res.match,
      similarity: Math.round(res.similarity * 1000) / 1000,
      ...(res.state === "superseded" ? { repliedAt: res.repliedAt } : { matchedAt: res.matchedAt }),
      ...(dup.scope ? { scope: dup.scope } : {}),
      phase: "approval.fulfill",
      ...dedupAuditMeta(prepared),
    };
    if (dup.scope === "cross_employee") {
      await auditCrossEmployee(ctx, prepared, "block", {
        scope: "cross_employee",
        match: dup.match,
        similarity: dup.similarity,
        matchedAt: dup.matchedAt,
      });
    }
    await closeAtFulfill(approval, "superseded", meta);
    return { ok: false, code: APPROVAL_SUPERSEDED };
  }
  await auditDedupUnavailable(ctx, res.state === "denied" ? "claim_denied" : res.state === "unavailable" ? res.reason : "claim_failed");
  return { ok: false, code: FULFILL_BLOCKED_DEDUP_UNAVAILABLE };
}

/** After the fulfill post. Sent → also supersede other pending approvals for the conversation with a similar body. */
export async function fulfillDedupFinish(
  gate: FulfillDedupGate,
  approval: ApprovalRequest,
  outcome: "sent" | "failed" | "uncertain"
): Promise<void> {
  if (!gate.ok || gate.prepared.kind !== "ready" || !gate.claimId) return;
  await finishCommReplySend({ id: gate.claimId, orgId: gate.prepared.orgId, outcome });
  if (outcome === "failed") return;
  // SNS posts are not conversation approvals: the next approval's own gate stops it.
  if ((approval.tool || "") === "sns.publish") return;
  await supersedePendingConversationApprovals({
    orgId: gate.prepared.orgId,
    employeeId: gate.prepared.employeeId,
    conversationKey: gate.prepared.conversationKey,
    fingerprint: gate.prepared.fingerprint,
    settings: gate.prepared.settings,
    reason: "newer_reply_sent",
    excludeApprovalId: approval.id,
    supersededBy: approval.id,
  }).catch(() => []);
}
