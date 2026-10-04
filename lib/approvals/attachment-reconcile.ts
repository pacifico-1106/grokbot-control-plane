/**
 * Scheduled reconcile of the approved-attachment upload (2026-10-04, #253
 * follow-up 1, 2 and 6). Runs from the W2 cron (app/api/cron/stuck-watch-w2)
 * behind APPROVAL_ATTACHMENT_RECONCILE_ENABLED (OFF by default → returns
 * { enabled:false } before reading anything). 八坂: ongoing operation needs no
 * manual work — no hand edits, no SQL.
 *
 * A. Upload claims (metadata.attachmentUpload) that are
 *      running   for ≥ N minutes (claimedAt), or
 *      uncertain for ≥ N minutes (finishedAt) — N = APPROVAL_ATTACHMENT_RECONCILE_STALE_MINUTES, default 10
 *    are checked against the approved conversation with a read-only lookup
 *    (shared interface `AttachmentShareVerifier`; Slack only today):
 *      found     → succeeded + fileId (re-runs return it, never upload)
 *      not_found → failed (the next agent re-run uploads exactly once)
 *      cannot check → uncertain; the admin agent is told ONCE through the
 *                     Admin MCP stuck-watch list (item a1:<approvalId>). No
 *                     human channel is used. Later runs re-check (and may
 *                     still settle it) but never notify again.
 *    Every write is conditional on the state + claimId that was read
 *    (reconcileAttachmentUpload), so concurrent runs / a re-run that took a new
 *    claim / the original holder finishing late can never be overwritten.
 *    One audit per applied outcome (filename / bytes / code only).
 *
 * B. Approvals whose approved text was posted while the approved attachment
 *    has no record at all get the not_sent marker + approval.attachment_not_sent
 *    audit (markAttachmentNotSent: conditional, idempotent).
 *
 * Non-Slack conversation surfaces: no verifier exists (the attachment upload
 * itself is Slack-only), so such a claim is left uncertain and the admin agent
 * is told once (code reconcile_surface_unsupported).
 */
import {
  attachmentUncertainItemId,
  markAttachmentNotSent,
  needsAttachmentNotSentMarker,
  readAttachmentUpload,
  reconcileAttachmentUpload,
  type AttachmentUploadRecord,
} from "@/lib/approvals/attachment-upload-claim";
import { readCardAttachment, sanitizeCardFilename } from "@/lib/approvals/attachment-card";
import { parseInvokeSnapshot } from "@/lib/approvals/fulfill";
import { snapshotAttachmentState } from "@/lib/approvals/snapshot-attachment";
import { appendAuditEvent } from "@/lib/data/audit";
import { isApprovalAttachmentReconcileEnabled } from "@/lib/feature-flags";
import { resolveConversationToken } from "@/lib/gateway/adapters/slack";
import { findApprovedFileShare, type ShareLookupResult } from "@/lib/slack/attachment-share-lookup";
import type { ApprovalRequest, AuditAction } from "@/lib/types";

export const DEFAULT_RECONCILE_STALE_MINUTES = 10;
const MIN_STALE_MINUTES = 5;
const MAX_STALE_MINUTES = 24 * 60;

export type AttachmentReconcileResult = {
  approvalId: string;
  from: "running" | "uncertain";
  outcome: "succeeded" | "failed" | "uncertain" | "skipped";
  code: string;
  /** true only for the run that told the admin agent. */
  notified?: boolean;
  /** false: the record changed since it was read (or was already notified) → nothing written. */
  applied: boolean;
};
export type AttachmentReconcileRun = {
  enabled: boolean;
  results: AttachmentReconcileResult[];
  notSentMarked: string[];
};

export function reconcileStaleMinutes(): number {
  const raw = Number(process.env.APPROVAL_ATTACHMENT_RECONCILE_STALE_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RECONCILE_STALE_MINUTES;
  return Math.min(Math.max(Math.floor(raw), MIN_STALE_MINUTES), MAX_STALE_MINUTES);
}

/** What the verifier needs; built from the approval snapshot only. */
export type AttachmentShareQuery = {
  orgId: string;
  employeeId: string;
  postingAs?: string | null;
  channel: string;
  threadTs: string;
  filename: string;
  bytes: number;
  claimedAt: Date;
};

/** Shared interface: one verifier per conversation surface. */
export interface AttachmentShareVerifier {
  verify(query: AttachmentShareQuery): Promise<ShareLookupResult>;
}

/** Channel / private channel / DM conversation id (a user id cannot be read as a thread). */
const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9_]{2,}$/;
const SLACK_TS = /^\d+\.\d+$/;

const slackVerifier: AttachmentShareVerifier = {
  async verify(query) {
    if (!SLACK_CHANNEL_ID.test(query.channel)) return { kind: "unverifiable", code: "reconcile_destination_unsupported" };
    if (!SLACK_TS.test(query.threadTs)) return { kind: "unverifiable", code: "reconcile_thread_missing" };
    const resolved = await resolveConversationToken({
      orgId: query.orgId, employeeId: query.employeeId, postingAs: query.postingAs,
    }).catch(() => ({ error: "unavailable" as const }));
    if ("error" in resolved) return { kind: "unverifiable", code: `reconcile_token_${resolved.error}` };
    if (!resolved.token) return { kind: "unverifiable", code: "reconcile_token_missing" };
    return findApprovedFileShare({
      token: resolved.token, channel: query.channel, threadTs: query.threadTs,
      filename: query.filename, bytes: query.bytes, claimedAt: query.claimedAt,
    });
  },
};

const VERIFIERS: Readonly<Record<string, AttachmentShareVerifier>> = { slack: slackVerifier };

type Candidate = { approval: ApprovalRequest; record: AttachmentUploadRecord & { state: "running" | "uncertain" } };

function staleCandidate(approval: ApprovalRequest, now: Date, staleMs: number): Candidate | null {
  const record = readAttachmentUpload(approval.metadata);
  if (!record || (record.state !== "running" && record.state !== "uncertain")) return null;
  const since = Date.parse((record.state === "running" ? record.claimedAt : record.finishedAt ?? record.claimedAt) ?? "");
  if (!Number.isFinite(since) || now.getTime() - since < staleMs) return null;
  return { approval, record: record as Candidate["record"] };
}

function display(approval: ApprovalRequest) {
  const card = readCardAttachment(approval.metadata);
  return card?.kind === "present"
    ? { filename: card.filename, ...(card.bytes !== undefined ? { bytes: card.bytes } : {}) }
    : {};
}

async function verify(candidate: Candidate): Promise<ShareLookupResult> {
  const { approval, record } = candidate;
  const state = snapshotAttachmentState(approval.metadata?.invoke);
  if (state.kind !== "present") return { kind: "unverifiable", code: "reconcile_snapshot_missing" };
  if (record.refSha256 && record.refSha256 !== state.attachment.refSha256) {
    return { kind: "unverifiable", code: "reconcile_ref_mismatch" };
  }
  if (typeof state.attachment.bytes !== "number") return { kind: "unverifiable", code: "reconcile_expected_size_unknown" };
  const claimedAt = new Date(record.claimedAt ?? "");
  if (!Number.isFinite(claimedAt.getTime())) return { kind: "unverifiable", code: "reconcile_claim_time_unknown" };
  const snapshot = parseInvokeSnapshot(approval.metadata);
  const conversation = snapshot?.conversation;
  const surface = conversation?.surface || (conversation?.slackChannelId || conversation?.slackUserId ? "slack" : "");
  const verifier = VERIFIERS[surface];
  if (!verifier) return { kind: "unverifiable", code: "reconcile_surface_unsupported" };
  return verifier.verify({
    orgId: snapshot?.orgId || approval.orgId,
    employeeId: snapshot?.employeeId || approval.employeeId,
    postingAs: snapshot?.postingAs,
    channel: conversation?.slackChannelId || conversation?.slackUserId || "",
    threadTs: conversation?.threadId || "",
    filename: state.attachment.filename,
    bytes: state.attachment.bytes,
    claimedAt,
  });
}

const OUTCOME_SUMMARY_JA: Record<"succeeded" | "failed" | "uncertain", string> = {
  succeeded: "添付の送信状態を自動照合: 承認された添付は共有済み（succeeded・再送しません）",
  failed: "添付の送信状態を自動照合: 共有されていない（failed・次の approvalId 付き再実行で1回だけ送信）",
  uncertain: "添付の送信状態を自動照合できず uncertain のまま（管理エージェントへ1回通知）",
};

async function audit(approval: ApprovalRequest, action: AuditAction, summary: string, metadata: Record<string, unknown>) {
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: null,
    action,
    purpose: "stuck_watch",
    summary,
    metadata: { approvalId: approval.id, tool: approval.tool, jobId: approval.jobId, phase: "stuck_watch.reconcile", ...metadata },
  }).catch(() => undefined);
}

async function reconcileOne(candidate: Candidate): Promise<AttachmentReconcileResult> {
  const { approval, record } = candidate;
  const from = record.state;
  const expected = { state: from, ...(record.claimId ? { claimId: record.claimId } : {}) };
  const shown = display(approval);
  const lookup = await verify(candidate).catch((): ShareLookupResult => ({ kind: "unverifiable", code: "reconcile_exception" }));

  if (lookup.kind === "found" || lookup.kind === "not_found") {
    const outcome = lookup.kind === "found" ? "succeeded" : "failed";
    const code = lookup.kind === "found" ? "reconcile_found" : "reconcile_not_found";
    const applied = await reconcileAttachmentUpload(approval, expected, outcome, {
      ...shown, code, ...(lookup.kind === "found" ? { fileId: lookup.fileId } : {}),
    });
    if (applied) await audit(approval, "approval.attachment_reconciled", OUTCOME_SUMMARY_JA[outcome], { outcome, from, ...shown, code });
    return { approvalId: approval.id, from, outcome, code, applied };
  }

  // Cannot check: stay uncertain, tell the admin agent once (refused when already notified).
  const code = lookup.code;
  const applied = await reconcileAttachmentUpload(approval, expected, "uncertain", { ...shown, code });
  if (applied) {
    await audit(approval, "approval.attachment_reconciled", OUTCOME_SUMMARY_JA.uncertain, { outcome: "uncertain", from, ...shown, code });
    await audit(approval, "stuck_watch.attachment_uncertain_notify",
      `A1 添付の送信結果を自動確認できません（${code}）: 管理エージェント向け stuck-watch 項目`, {
        itemId: attachmentUncertainItemId(approval.id), kind: "a1_attachment_uncertain", ...shown, code,
      });
  }
  return { approvalId: approval.id, from, outcome: "uncertain", code, applied, notified: applied };
}

function notSentMarker(approval: ApprovalRequest) {
  const state = snapshotAttachmentState(approval.metadata?.invoke);
  if (state.kind !== "present") return null;
  const card = readCardAttachment(approval.metadata);
  const filename = card?.kind === "present" ? card.filename : sanitizeCardFilename(state.attachment.filename);
  if (!filename) return null;
  return {
    status: "not_sent" as const,
    reason: "rerun_required" as const,
    filename,
    ...(state.attachment.bytes !== undefined ? { bytes: state.attachment.bytes } : {}),
  };
}

function textPostedLongEnough(approval: ApprovalRequest, now: Date, staleMs: number): boolean {
  const f = approval.metadata?.fulfillment as { at?: unknown } | undefined;
  const at = Date.parse(typeof f?.at === "string" ? f.at : "");
  return Number.isFinite(at) && now.getTime() - at >= staleMs;
}

export async function runApprovalAttachmentReconcile(
  approvals: ApprovalRequest[],
  opts: { now?: Date } = {}
): Promise<AttachmentReconcileRun> {
  if (!isApprovalAttachmentReconcileEnabled()) return { enabled: false, results: [], notSentMarked: [] };
  const now = opts.now ?? new Date();
  const staleMs = reconcileStaleMinutes() * 60_000;
  const results: AttachmentReconcileResult[] = [];
  const notSentMarked: string[] = [];

  for (const approval of approvals) {
    const candidate = staleCandidate(approval, now, staleMs);
    if (candidate) {
      results.push(await reconcileOne(candidate));
      continue;
    }
    if (approval.status !== "approved" || !needsAttachmentNotSentMarker(approval.metadata)) continue;
    if (!textPostedLongEnough(approval, now, staleMs)) continue;
    const marker = notSentMarker(approval);
    if (!marker) continue;
    if (!(await markAttachmentNotSent(approval, marker))) continue;
    notSentMarked.push(approval.id);
    await audit(approval, "approval.attachment_not_sent",
      "承認済みの本文は投稿済み・承認された添付は未送信（定期確認で記録。エージェントの approvalId 付き再実行で送信）", {
        reason: "rerun_required", filename: marker.filename, ...(marker.bytes !== undefined ? { bytes: marker.bytes } : {}),
      });
  }
  return { enabled: true, results, notSentMarked };
}
