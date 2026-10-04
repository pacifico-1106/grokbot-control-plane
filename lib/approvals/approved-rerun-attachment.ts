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
 */
import { getApprovalById, updateApprovalMetadata } from "@/lib/data/approvals";
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

type AttachmentFulfillment = { ok: true; fileId: string; filename: string; bytes: number; refSha256: string; at: string };

function priorAttachmentFulfillment(approval: ApprovalRequest | null, refSha256: string): AttachmentFulfillment | null {
  const raw = approval?.metadata?.attachmentFulfillment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  return rec.ok === true && typeof rec.fileId === "string" && rec.refSha256 === refSha256
    ? (rec as unknown as AttachmentFulfillment)
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

  // Idempotent: a re-run after a successful upload never uploads again.
  const latest = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  const done = priorAttachmentFulfillment(latest ?? approval, approved.refSha256);
  if (done) {
    return { received: true, fileUpload: { ok: true, fileId: done.fileId, filename: done.filename, bytes: done.bytes } };
  }

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

  const uploaded = await uploadSlackFile({
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
  if (!uploaded.ok) {
    await audit("slack.file_upload_failed", `承認済み添付のアップロードに失敗: ${uploaded.error}`, {
      code: uploaded.code,
      error: uploaded.error,
      filename: approved.filename,
      channel: dest,
      threadTs,
    });
    return { received: true, fileUpload: buildFileUploadFailed(uploaded) };
  }
  await updateApprovalMetadata(latest ?? approval, {
    attachmentFulfillment: {
      ok: true,
      fileId: uploaded.fileId,
      filename: uploaded.filename,
      bytes: uploaded.bytes,
      refSha256: approved.refSha256,
      at: new Date().toISOString(),
    } satisfies AttachmentFulfillment,
  }).catch(() => undefined);
  await audit("slack.file_uploaded", `承認済み添付をアップロード: ${uploaded.filename}`,
    buildFileUploadAuditPayload(uploaded, {
      jobId: ctx.jobId,
      audience: fileAudience.audience,
      mimeType: approved.mimeType,
      fileRef,
    }));
  return { received: true, fileUpload: buildFileUploadSuccess(uploaded) };
}
