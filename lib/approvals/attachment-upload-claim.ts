/**
 * Upload claim for the approved attachment (2026-10-04, #252 follow-up).
 *
 * One claim per approval, taken BEFORE anything is downloaded or uploaded, so
 * concurrent re-runs of the same approval upload at most once. The record lives
 * in `approval_requests.metadata.attachmentUpload` (no new table / column):
 *
 *   { state: "running" | "succeeded" | "failed" | "uncertain",
 *     claimId, refSha256, claimedAt, finishedAt?, fileId?, filename?, bytes?, code? }
 *
 *   running   → another worker holds the claim: do not upload (in_progress)
 *   succeeded → uploaded: never upload again (return the stored file id)
 *   failed    → failed before Slack could share the file: a later re-run may claim again
 *   uncertain → the outcome is unknown (the upload may have been shared):
 *               never retried automatically; a human checks the channel
 *
 * Production: atomic conditional update in the DB (RPC
 * claim_approval_attachment_upload / finish_approval_attachment_upload: row lock
 * on approval_requests, see supabase/migrations/*_approval_attachment_upload_claim.sql).
 * Any RPC error fails CLOSED ("unavailable" → no upload).
 * Demo: the check-and-set is one synchronous step on an in-process map (same
 * approach as the text claim in lib/approvals/execution.ts), mirrored to metadata.
 */
import { randomUUID } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { getApprovalById, updateApprovalMetadata } from "@/lib/data/approvals";
import type { ApprovalRequest } from "@/lib/types";

export type AttachmentUploadState = "running" | "succeeded" | "failed" | "uncertain";
export type AttachmentUploadRecord = {
  state: AttachmentUploadState;
  claimId?: string;
  refSha256?: string;
  claimedAt?: string;
  finishedAt?: string;
  fileId?: string;
  filename?: string;
  bytes?: number;
  code?: string;
};
export type AttachmentUploadResult = { fileId?: string; filename?: string; bytes?: number; code?: string };

export type AttachmentUploadClaim =
  | { kind: "claimed"; claimId: string }
  | { kind: "succeeded"; fileId: string; filename: string; bytes: number }
  | { kind: "running" }
  | { kind: "uncertain" }
  | { kind: "denied" }
  | { kind: "unavailable" };

const STATES: readonly AttachmentUploadState[] = ["running", "succeeded", "failed", "uncertain"];
const demoClaims = new Map<string, AttachmentUploadRecord>();

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function readAttachmentUpload(metadata: Record<string, unknown> | null | undefined): AttachmentUploadRecord | null {
  const rec = obj(metadata?.attachmentUpload);
  if (!rec || !STATES.includes(rec.state as AttachmentUploadState)) return null;
  const out: AttachmentUploadRecord = { state: rec.state as AttachmentUploadState };
  for (const k of ["claimId", "refSha256", "claimedAt", "finishedAt", "fileId", "filename", "code"] as const) {
    const v = str(rec[k]);
    if (v) out[k] = v;
  }
  const bytes = num(rec.bytes);
  if (bytes !== undefined) out.bytes = bytes;
  return out;
}

/** #252 wrote `attachmentFulfillment` after a successful upload (records already in production). */
function legacySuccess(metadata: Record<string, unknown> | null | undefined, refSha256: string) {
  const rec = obj(metadata?.attachmentFulfillment);
  if (!rec || rec.ok !== true || rec.refSha256 !== refSha256 || !str(rec.fileId)) return null;
  return { fileId: String(rec.fileId), filename: str(rec.filename) ?? "", bytes: num(rec.bytes) ?? 0 };
}

/** Only these fields ever reach the stored record (never a reference / URL / token). */
function pickResult(result: AttachmentUploadResult): AttachmentUploadResult {
  const out: AttachmentUploadResult = {};
  if (str(result.fileId)) out.fileId = result.fileId;
  if (str(result.filename)) out.filename = result.filename;
  if (num(result.bytes) !== undefined) out.bytes = result.bytes;
  if (str(result.code)) out.code = result.code;
  return out;
}

function fromRpc(data: unknown): AttachmentUploadClaim | null {
  const rec = obj(data);
  switch (rec?.state) {
    case "running": return { kind: "running" };
    case "uncertain": return { kind: "uncertain" };
    case "denied": return { kind: "denied" };
    case "succeeded": {
      const upload = obj(rec.upload) ?? {};
      const fileId = str(upload.fileId);
      return fileId ? { kind: "succeeded", fileId, filename: str(upload.filename) ?? "", bytes: num(upload.bytes) ?? 0 } : null;
    }
    default: return null;
  }
}

export async function claimAttachmentUpload(approval: ApprovalRequest, refSha256: string): Promise<AttachmentUploadClaim> {
  const claimId = randomUUID();
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) return { kind: "unavailable" };
    try {
      const { data, error } = await admin.rpc("claim_approval_attachment_upload", {
        p_id: approval.id, p_org: approval.orgId, p_claim: claimId, p_ref: refSha256,
      });
      if (error || !data) return { kind: "unavailable" };
      if (obj(data)?.state === "claimed") return { kind: "claimed", claimId };
      return fromRpc(data) ?? { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  const current = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  // ---- synchronous check-and-set (no await until the claim is recorded) ----
  if (!current || current.status !== "approved") return { kind: "denied" };
  const key = `${approval.orgId}:${approval.id}`;
  const record = demoClaims.get(key) ?? readAttachmentUpload(current.metadata);
  const prior = legacySuccess(current.metadata, refSha256);
  if (prior) return { kind: "succeeded", ...prior };
  if (record?.state === "succeeded" && record.fileId) {
    return { kind: "succeeded", fileId: record.fileId, filename: record.filename ?? "", bytes: record.bytes ?? 0 };
  }
  if (record?.state === "running" || record?.state === "uncertain") return { kind: record.state };
  const claimed: AttachmentUploadRecord = { state: "running", claimId, refSha256, claimedAt: new Date().toISOString() };
  demoClaims.set(key, claimed);
  // ---------------------------------------------------------------------------
  await updateApprovalMetadata(current, { attachmentUpload: claimed }).catch(() => undefined);
  return { kind: "claimed", claimId };
}

/**
 * Close the claim. Only the holder of a running claim can close it. Returns
 * false when the record could not be written (the claim then stays "running",
 * which blocks further uploads — fail closed).
 */
export async function finishAttachmentUpload(
  approval: ApprovalRequest,
  claimId: string,
  state: Exclude<AttachmentUploadState, "running">,
  result: AttachmentUploadResult
): Promise<boolean> {
  const picked = pickResult(result);
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) return false;
    try {
      const { data, error } = await admin.rpc("finish_approval_attachment_upload", {
        p_id: approval.id, p_org: approval.orgId, p_claim: claimId, p_state: state, p_result: picked,
      });
      return !error && data === true;
    } catch {
      return false;
    }
  }
  const key = `${approval.orgId}:${approval.id}`;
  const record = demoClaims.get(key);
  if (!record || record.state !== "running" || record.claimId !== claimId) return false;
  const next: AttachmentUploadRecord = { ...record, ...picked, state, finishedAt: new Date().toISOString() };
  demoClaims.set(key, next);
  const current = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  if (current) await updateApprovalMetadata(current, { attachmentUpload: next }).catch(() => undefined);
  return true;
}

/**
 * What the fulfillment result reports about the approved attachment.
 *   not_sent    — only the approved text was posted (approval callback / W2);
 *                 the agent re-run with the approvalId uploads the file
 *   sent        — uploaded once (file id)
 *   in_progress / uncertain / failed — the re-run's upload claim state
 */
export type FulfillmentFileUpload =
  | { status: "not_sent"; reason: "rerun_required"; filename: string; bytes?: number }
  | { status: "sent"; fileId: string; filename: string; bytes?: number }
  | { status: "in_progress" | "uncertain" | "failed"; filename?: string; bytes?: number; code?: string };

export function parseStoredFileUpload(value: unknown): FulfillmentFileUpload | undefined {
  const rec = obj(value);
  if (!rec || rec.status !== "not_sent" || rec.reason !== "rerun_required") return undefined;
  const filename = str(rec.filename);
  if (!filename) return undefined;
  const bytes = num(rec.bytes);
  return { status: "not_sent", reason: "rerun_required", filename, ...(bytes !== undefined ? { bytes } : {}) };
}

/** Live view: the upload claim record (or #252's attachmentFulfillment) wins over the stored marker. */
export function liveFileUpload(
  metadata: Record<string, unknown> | null | undefined,
  stored: FulfillmentFileUpload | undefined
): FulfillmentFileUpload | undefined {
  const upload = readAttachmentUpload(metadata);
  const display = (u: AttachmentUploadRecord) => ({
    ...(u.filename ? { filename: u.filename } : {}),
    ...(u.bytes !== undefined ? { bytes: u.bytes } : {}),
  });
  if (upload?.state === "succeeded" && upload.fileId) {
    return { status: "sent", fileId: upload.fileId, filename: upload.filename ?? "", ...(upload.bytes !== undefined ? { bytes: upload.bytes } : {}) };
  }
  if (upload?.state === "running") return { status: "in_progress", ...display(upload) };
  if (upload?.state === "uncertain") return { status: "uncertain", ...display(upload), ...(upload.code ? { code: upload.code } : {}) };
  if (upload?.state === "failed") {
    return stored ?? { status: "failed", ...display(upload), ...(upload.code ? { code: upload.code } : {}) };
  }
  const legacy = obj(metadata?.attachmentFulfillment);
  if (legacy?.ok === true && str(legacy.fileId)) {
    const bytes = num(legacy.bytes);
    return { status: "sent", fileId: String(legacy.fileId), filename: str(legacy.filename) ?? "", ...(bytes !== undefined ? { bytes } : {}) };
  }
  return stored;
}

/** True when the approved attachment is already uploaded (claim record or #252 record). */
export function attachmentAlreadyUploaded(metadata: Record<string, unknown> | null | undefined): boolean {
  return liveFileUpload(metadata, undefined)?.status === "sent";
}
