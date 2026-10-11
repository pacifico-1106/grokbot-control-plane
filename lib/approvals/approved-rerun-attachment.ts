/**
 * Approved re-run: the attachment side of "deliver only what was approved"
 * (2026-10-04, #252). The request's fileAttachment is NEVER uploaded here; only
 * the snapshot's sealed reference (lib/approvals/snapshot-attachment.ts).
 *
 *   snapshot legacy + request attachment → blocked before anything is posted
 *       (see `legacySnapshotAttachmentBlock`, 409 approval_snapshot_missing_attachment)
 *   snapshot none   + request attachment → not uploaded (approval_attachment_not_approved)
 *   snapshot present                     → upload the approved file once, to the
 *       approved destination/thread, under the approval-time file egress rule;
 *       a differing request attachment is ignored and audited.
 *
 * "Once" holds under concurrent re-runs (#252 follow-up): an upload claim is
 * taken before anything is downloaded (lib/approvals/attachment-upload-claim.ts).
 * A re-run that cannot take it does not upload (in_progress). An unknown
 * outcome (exception / completion step timed out / 5xx / unknown error) is
 * recorded as "uncertain" and never re-uploaded by a re-run; a Slack error
 * known to precede sharing (lib/slack/definite-errors.ts) is "failed". With
 * APPROVAL_ATTACHMENT_RECONCILE_ENABLED the W2 cron settles stale running /
 * uncertain claims by checking the conversation (lib/approvals/attachment-reconcile.ts).
 */
import { getApprovalById } from "@/lib/data/approvals";
import {
  claimAttachmentUpload,
  finishAttachmentUpload,
  liveFileUpload,
  readAttachmentUpload,
} from "@/lib/approvals/attachment-upload-claim";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  buildFileUploadAuditPayload,
  buildFileUploadEgressDenied,
  buildFileUploadFailed,
  buildFileUploadSuccess,
  evaluateFileAttachmentEgress,
  uploadSlackFile,
  type FileUploadResponse,
} from "@/lib/gateway/adapters/slack-file-upload";
import { parseInvokeSnapshot } from "@/lib/approvals/fulfill";
import { isDefinitePreShareSlackError } from "@/lib/slack/definite-errors";
import { reinvokeReasonForFileUpload } from "@/lib/approvals/poll-hint";
import { ATTACHMENT_RETRY_CAP } from "@/lib/approvals/attachment-retry-cap";
import { isApprovalAttachmentReconcileEnabled } from "@/lib/feature-flags";
import {
  describeRequestAttachment,
  openSnapshotAttachmentRef,
  requestHasAttachment,
  requestMatchesSnapshotAttachment,
  snapshotAttachmentState,
} from "@/lib/approvals/snapshot-attachment";
import type { ApprovalRequest, Audience, AuditAction, GatewayInvokeRequest } from "@/lib/types";

export const APPROVAL_SNAPSHOT_MISSING_ATTACHMENT = "approval_snapshot_missing_attachment";
export const APPROVAL_ATTACHMENT_NOT_APPROVED = "approval_attachment_not_approved";
export const APPROVAL_ATTACHMENT_UNAVAILABLE = "approval_attachment_unavailable";
export const APPROVAL_ATTACHMENT_UPLOAD_IN_PROGRESS = "approval_attachment_upload_in_progress";
export const APPROVAL_ATTACHMENT_UPLOAD_UNCERTAIN = "approval_attachment_upload_uncertain";
export const APPROVAL_ATTACHMENT_CLAIM_UNAVAILABLE = "approval_attachment_claim_unavailable";
export const APPROVAL_ATTACHMENT_RETRY_CAPPED = "approval_attachment_retry_capped";

function retryCappedMessageJa(code: string, count: number): string {
  return `同じ承認で同じ Slack エラー（${code}）が${count}回続いたため、設定が変わるまで Slack には送信しません（添付は未送信）。` +
    "reinvokeReason の nextTool で設定を直してから、approvalId 付きでもう一度実行してください。";
}

const UNCERTAIN_PREFIX_JA =
  "添付ファイルの送信結果を確認できませんでした（Slack 側で共有された可能性があります）。二重送信を防ぐため自動では再送しません。";

/**
 * 木村 4 (2026-10-04): while APPROVAL_ATTACHMENT_RECONCILE_ENABLED is ON the
 * scheduled reconcile settles the record by itself, so the message says so.
 * OFF → the previous wording, unchanged. Evaluated per call (flag at run time).
 */
export function uncertainMessageJa(): string {
  return isApprovalAttachmentReconcileEnabled()
    ? `${UNCERTAIN_PREFIX_JA}Staffpass が自動で確認し、送信済みか未送信かを確定します。`
    : `${UNCERTAIN_PREFIX_JA}チャンネルを確認し、必要なら管理者が対応してください。`;
}

/**
 * uploadSlackFile returns before files.completeUploadExternal for every other
 * failure, so the file was never shared. At (or after) the completion step the
 * outcome is unknown (a timeout, a 5xx or an unknown error may follow a
 * share) — unless Slack answered one of the errors known to precede sharing
 * (lib/slack/definite-errors.ts, #253 follow-up 3): then it is "failed".
 */
const OUTCOME_UNKNOWN_CODES = new Set(["complete_upload_failed"]);

function outcomeUnknown(uploaded: { code: string; slackError?: string }): boolean {
  return OUTCOME_UNKNOWN_CODES.has(uploaded.code) && !isDefinitePreShareSlackError(uploaded.slackError);
}

const SLACK_TS = /^\d+\.\d+$/;

type AuditContext = {
  orgId: string;
  employeeId: string;
  credentialId: string | null;
  tool: string;
  purpose: string;
  jobId: string;
};

/**
 * Legacy record (snapshot has no attachment field) re-run WITH a request
 * attachment: the approved attachment is unknown → nothing may be delivered.
 * Must be checked before the approved text is posted.
 */
export function legacySnapshotAttachmentBlock(
  approval: ApprovalRequest,
  body: GatewayInvokeRequest
): { code: typeof APPROVAL_SNAPSHOT_MISSING_ATTACHMENT; messageJa: string } | null {
  if (!requestHasAttachment(body)) return null;
  if (snapshotAttachmentState(approval.metadata?.invoke).kind !== "legacy") return null;
  return {
    code: APPROVAL_SNAPSHOT_MISSING_ATTACHMENT,
    messageJa:
      "この承認は添付ファイルの記録がない旧形式です。添付付きで送るには、同じ内容で承認を取り直してください（再承認）。本文も添付も送信していません。",
  };
}

export async function auditLegacySnapshotAttachmentBlock(
  approval: ApprovalRequest,
  body: GatewayInvokeRequest,
  ctx: AuditContext
): Promise<void> {
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId,
    action: "approval.snapshot_missing_attachment",
    purpose: ctx.purpose,
    summary: `${ctx.tool} の承認後再実行を停止: 旧形式の承認に添付の記録がない（再承認が必要）`,
    metadata: {
      approvalId: approval.id,
      tool: ctx.tool,
      jobId: ctx.jobId,
      code: APPROVAL_SNAPSHOT_MISSING_ATTACHMENT,
      ...describeRequestAttachment(body.fileAttachment),
    },
  }).catch(() => undefined);
}

/** Stored success: this follow-up's claim record, or #252's attachmentFulfillment. */
function priorUpload(
  approval: ApprovalRequest,
  refSha256: string
): { fileId: string; filename: string; bytes: number } | null {
  const upload = readAttachmentUpload(approval.metadata);
  if (upload?.state === "succeeded" && upload.fileId) {
    return { fileId: upload.fileId, filename: upload.filename ?? "", bytes: upload.bytes ?? 0 };
  }
  const raw = approval.metadata?.attachmentFulfillment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  return rec.ok === true && typeof rec.fileId === "string" && rec.refSha256 === refSha256
    ? { fileId: rec.fileId, filename: String(rec.filename ?? ""), bytes: typeof rec.bytes === "number" ? rec.bytes : 0 }
    : null;
}

function approvalTimeFileAudience(approval: ApprovalRequest): {
  audience: Audience;
  effectiveAudience: "internal" | "external";
} {
  const egress = approval.metadata?.egress as { audience?: unknown; effectiveAudience?: unknown } | undefined;
  const audience = (["internal", "external", "unknown"] as const).find((a) => a === egress?.audience) ?? "unknown";
  return { audience, effectiveAudience: egress?.effectiveAudience === "internal" ? "internal" : "external" };
}

/**
 * Deliver the approved attachment for an approved re-run. Returns what the
 * response should report: `received` mirrors the P0 contract (fileUpload is
 * always present when an attachment was in play).
 */
export async function deliverApprovedRerunAttachment(input: {
  approval: ApprovalRequest;
  body: GatewayInvokeRequest;
  ctx: AuditContext;
}): Promise<{ received: boolean; fileUpload?: FileUploadResponse }> {
  const { approval, body, ctx } = input;
  const state = snapshotAttachmentState(approval.metadata?.invoke);
  const requestAttachment = requestHasAttachment(body) ? body.fileAttachment : undefined;
  const audit = (action: AuditAction, summary: string, metadata: Record<string, unknown>) =>
    appendAuditEvent({
      orgId: ctx.orgId,
      employeeId: ctx.employeeId,
      credentialId: ctx.credentialId,
      action,
      purpose: ctx.purpose,
      summary,
      metadata: { approvalId: approval.id, tool: ctx.tool, jobId: ctx.jobId, phase: "approval.rerun", ...metadata },
    }).catch(() => undefined);

  if (state.kind !== "present") {
    // legacy + request attachment is blocked earlier (409) — reaching here means none.
    if (!requestAttachment) return { received: false };
    await audit("approval.attachment_request_ignored",
      "承認後再実行: 承認内容に添付がないため、リクエストの添付を無視しました", {
        reason: "not_approved",
        ...describeRequestAttachment(requestAttachment),
      });
    return {
      received: true,
      fileUpload: {
        ok: false,
        code: APPROVAL_ATTACHMENT_NOT_APPROVED,
        reason: APPROVAL_ATTACHMENT_NOT_APPROVED,
        messageJa: "承認された内容に添付ファイルはありません。添付は送信していません（添付するには承認を取り直してください）。",
      },
    };
  }

  const approved = state.attachment;
  if (requestAttachment && !requestMatchesSnapshotAttachment(requestAttachment, approved)) {
    await audit("approval.attachment_request_ignored",
      "承認後再実行: リクエストの添付が承認内容と異なるため無視し、承認された添付のみ扱います", {
        reason: "differs_from_snapshot",
        approvedFilename: approved.filename,
        approvedRefSha256: approved.refSha256,
        ...describeRequestAttachment(requestAttachment),
      });
  }

  // Fast path: already uploaded → never upload again (the claim below is the
  // authoritative check; this only skips the egress / reference work).
  const latest = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  const done = priorUpload(latest ?? approval, approved.refSha256);
  if (done) return { received: true, fileUpload: { ok: true, ...done } };

  const snapshot = parseInvokeSnapshot(approval.metadata);
  const dest = snapshot?.conversation?.slackChannelId || snapshot?.conversation?.slackUserId || "";
  const threadTs = snapshot?.conversation?.threadId || "";
  const fileAudience = approvalTimeFileAudience(approval);
  const fileEgress = evaluateFileAttachmentEgress({
    ...fileAudience,
    threadTs: SLACK_TS.test(threadTs) ? threadTs : undefined,
    channel: dest,
  });
  if (!fileEgress.allowed) {
    await audit("slack.file_egress_denied", `承認済み添付を拒否: ${fileEgress.reason}`, {
      reason: fileEgress.reason,
      ...fileAudience,
      filename: approved.filename,
      channel: dest,
      threadTs,
    });
    return { received: true, fileUpload: buildFileUploadEgressDenied(fileEgress) };
  }

  const fileRef = openSnapshotAttachmentRef(approved);
  if (!fileRef) {
    await audit("slack.file_upload_failed", "承認済み添付の参照を復元できないためアップロードしませんでした", {
      code: APPROVAL_ATTACHMENT_UNAVAILABLE,
      filename: approved.filename,
      sealed: approved.sealed,
    });
    return {
      received: true,
      fileUpload: {
        ok: false,
        code: APPROVAL_ATTACHMENT_UNAVAILABLE,
        reason: APPROVAL_ATTACHMENT_UNAVAILABLE,
        messageJa: "承認された添付ファイルの参照を復元できないため、添付は送信していません。承認を取り直してください。",
      },
    };
  }

  // One upload per approval: take the claim before downloading anything.
  // 木村 #255 second round (reconcile flag ON): the claim also enforces the
  // retry cap (same definite Slack error ATTACHMENT_RETRY_CAP× in a row → no Slack call).
  const reconcileOn = isApprovalAttachmentReconcileEnabled();
  const claim = await claimAttachmentUpload(latest ?? approval, approved.refSha256,
    reconcileOn ? { retryCap: ATTACHMENT_RETRY_CAP } : {});
  const display = { filename: approved.filename, ...(approved.bytes !== undefined ? { bytes: approved.bytes } : {}) };
  if (claim.kind === "capped") {
    // Same reason as the poll: built from the stored failed record by the one builder.
    const current = await getApprovalById(approval.id, approval.orgId).catch(() => null);
    const reinvokeReason = reinvokeReasonForFileUpload(liveFileUpload((current ?? latest ?? approval).metadata, undefined));
    await audit("approval.attachment_upload_capped",
      `承認後再実行: 同じ Slack エラー（${claim.code}）が${claim.count}回続いたため、設定が変わるまで添付を送信しません`, {
        ...display, code: claim.code, consecutive: claim.count, limit: ATTACHMENT_RETRY_CAP,
      });
    return {
      received: true,
      fileUpload: {
        ok: false,
        code: APPROVAL_ATTACHMENT_RETRY_CAPPED,
        reason: claim.code,
        status: "failed",
        messageJa: retryCappedMessageJa(claim.code, claim.count),
        ...(reinvokeReason ? { reinvokeReason } : {}),
        retryCap: { consecutive: claim.count, limit: ATTACHMENT_RETRY_CAP },
      },
    };
  }
  if (claim.kind === "succeeded") {
    return { received: true, fileUpload: { ok: true, fileId: claim.fileId, filename: claim.filename, bytes: claim.bytes } };
  }
  if (claim.kind === "running") {
    await audit("approval.attachment_upload_in_progress",
      "承認後再実行: 同じ承認の添付を別の実行がアップロード中のため、アップロードしませんでした", display);
    return {
      received: true,
      fileUpload: {
        ok: false,
        code: APPROVAL_ATTACHMENT_UPLOAD_IN_PROGRESS,
        reason: APPROVAL_ATTACHMENT_UPLOAD_IN_PROGRESS,
        status: "in_progress",
        messageJa: "同じ承認の添付ファイルを別の実行が送信中です。二重送信を防ぐため、この実行では送信していません。",
      },
    };
  }
  if (claim.kind === "uncertain") {
    return {
      received: true,
      fileUpload: {
        ok: false,
        code: APPROVAL_ATTACHMENT_UPLOAD_UNCERTAIN,
        reason: APPROVAL_ATTACHMENT_UPLOAD_UNCERTAIN,
        status: "uncertain",
        messageJa: uncertainMessageJa(),
      },
    };
  }
  if (claim.kind !== "claimed") {
    // denied (no longer approved) or the claim store is unavailable → fail closed.
    await audit("slack.file_upload_failed", "承認済み添付の送信権を確保できないためアップロードしませんでした", {
      code: APPROVAL_ATTACHMENT_CLAIM_UNAVAILABLE,
      claim: claim.kind,
      ...display,
    });
    return {
      received: true,
      fileUpload: {
        ok: false,
        code: APPROVAL_ATTACHMENT_CLAIM_UNAVAILABLE,
        reason: claim.kind,
        status: "failed",
        messageJa: "添付ファイルの送信を確保できなかったため、添付は送信していません（本文の送信結果は別に返します）。",
      },
    };
  }

  const markUncertain = async (code: string, error: string) => {
    const recorded = await finishAttachmentUpload(approval, claim.claimId, "uncertain", { ...display, code });
    await audit("approval.attachment_upload_uncertain",
      "承認後再実行: 添付の送信結果が不明のため uncertain として停止（自動再送しません）", {
        ...display,
        code,
        error,
        channel: dest,
        threadTs,
        claimRecorded: recorded,
        nextAction: "manual_check",
      });
    return {
      received: true,
      fileUpload: {
        ok: false as const,
        code: APPROVAL_ATTACHMENT_UPLOAD_UNCERTAIN,
        reason: code,
        status: "uncertain" as const,
        messageJa: uncertainMessageJa(),
      },
    };
  };

  let uploaded: Awaited<ReturnType<typeof uploadSlackFile>>;
  try {
    uploaded = await uploadSlackFile({
      orgId: snapshot?.orgId || approval.orgId,
      employeeId: snapshot?.employeeId || ctx.employeeId,
      postingAs: snapshot?.postingAs,
      channel: dest,
      threadTs,
      fileRef,
      fileUrl: fileRef.startsWith("http") ? fileRef : undefined,
      filename: approved.filename,
      mimeType: approved.mimeType,
      title: approved.title,
      initialComment: approved.initialComment,
      expectedBytes: approved.bytes,
    });
  } catch (error) {
    return markUncertain("upload_exception", error instanceof Error ? error.name : "upload_exception");
  }
  if (!uploaded.ok) {
    if (outcomeUnknown(uploaded)) return markUncertain(uploaded.code, uploaded.error);
    // slackError / slackNeeded are kept only for a definite pre-share error (pickResult) → reinvokeReason (木村 5)
    await finishAttachmentUpload(approval, claim.claimId, "failed", {
      ...display, code: uploaded.code, slackError: uploaded.slackError, slackNeeded: uploaded.slackNeeded,
      slackTokenType: uploaded.slackTokenType,
    });
    await audit("slack.file_upload_failed", `承認済み添付のアップロードに失敗: ${uploaded.error}`, {
      code: uploaded.code,
      error: uploaded.error,
      filename: approved.filename,
      channel: dest,
      threadTs,
    });
    const failed = buildFileUploadFailed(uploaded);
    // 木村 #255 second round: the re-run says why too — same builder as the poll / MCP.
    const reinvokeReason = reconcileOn && isDefinitePreShareSlackError(uploaded.slackError)
      ? reinvokeReasonForFileUpload({
          status: "failed", slackError: uploaded.slackError, slackNeeded: uploaded.slackNeeded, slackTokenType: uploaded.slackTokenType,
        })
      : null;
    return {
      received: true,
      fileUpload: failed.ok ? failed : { ...failed, status: "failed", ...(reinvokeReason ? { reinvokeReason } : {}) },
    };
  }
  const recorded = await finishAttachmentUpload(approval, claim.claimId, "succeeded", {
    fileId: uploaded.fileId,
    filename: uploaded.filename,
    bytes: uploaded.bytes,
  });
  await audit("slack.file_uploaded", `承認済み添付をアップロード: ${uploaded.filename}`, {
    ...buildFileUploadAuditPayload(uploaded, {
      jobId: ctx.jobId,
      audience: fileAudience.audience,
      mimeType: approved.mimeType,
      fileRef,
    }),
    // false: uploaded, but the claim could not be closed — it stays "running",
    // which keeps blocking further uploads (fail closed; clear manually).
    claimRecorded: recorded,
  });
  return { received: true, fileUpload: buildFileUploadSuccess(uploaded) };
}
