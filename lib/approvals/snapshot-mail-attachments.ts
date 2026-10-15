/**
 * Approval snapshot for mail.send attachments.
 *
 * Display fields (filename / mimeType / bytes) are what the approver sees.
 * `contentSha256` is the SHA-256 of the exact bytes that will be sent.
 * `contentCiphertext` is those bytes sealed with the notification AES-256-GCM
 * key (redacted from every public view). Send-time decrypt + hash must match
 * or the send is denied (mail_attachment_hash_mismatch).
 *
 * Production stores these on approval_requests.metadata.invoke.mailAttachments
 * (migration 20261015100000 is optional). Snapshot args never include the
 * original Base64 — only the sealed field. A 690 KiB PDF is ~920 KiB as
 * Base64 on the wire and ~920 KiB as `b1.` ciphertext in metadata (AES-GCM
 * ciphertext is the same length as plaintext, then base64url). Postgres
 * jsonb TOAST handles that. The 15 MiB total cap would be ~20 MiB of
 * ciphertext in one row — still under the 1 GiB jsonb limit, but large for
 * PostgREST/API payloads; the unused table is for that later. The 690 KiB
 * immediate-use PDF is not too large for metadata.
 *
 * Never stored in plaintext: file body, Base64, fileRef URL / query.
 * Logging must not include contents or ciphertext.
 */
import { createHash } from "node:crypto";
import { decryptBytes, encryptBytes } from "@/lib/notify/crypto";
import type { ResolvedMailAttachment } from "@/lib/mail/attachments";

export type SnapshotMailAttachment = {
  filename: string;
  mimeType: string;
  bytes: number;
  contentSha256: string;
  sealed: boolean;
  contentCiphertext?: string;
};

export type SnapshotMailAttachmentState =
  | { kind: "legacy" }
  | { kind: "none" }
  | { kind: "present"; attachments: SnapshotMailAttachment[] };

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

export function buildSnapshotMailAttachments(
  attachments: ResolvedMailAttachment[] | undefined | null
): SnapshotMailAttachment[] | null {
  if (!attachments || attachments.length === 0) return null;
  const out: SnapshotMailAttachment[] = [];
  for (const att of attachments) {
    let ciphertext: string | undefined;
    let sealed = false;
    try {
      ciphertext = encryptBytes(att.buffer);
      sealed = true;
    } catch {
      return null;
    }
    const opened = decryptBytes(ciphertext);
    if (sha256(opened) !== att.contentSha256) return null;
    out.push({
      filename: att.filename,
      mimeType: att.mimeType,
      bytes: att.bytes,
      contentSha256: att.contentSha256,
      sealed,
      contentCiphertext: ciphertext,
    });
  }
  return out;
}

export function snapshotMailAttachmentState(invoke: unknown): SnapshotMailAttachmentState {
  if (!invoke || typeof invoke !== "object" || Array.isArray(invoke)) return { kind: "legacy" };
  const rec = invoke as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rec, "mailAttachments")) return { kind: "legacy" };
  const raw = rec.mailAttachments;
  if (raw === null) return { kind: "none" };
  if (!Array.isArray(raw) || raw.length === 0) return { kind: "none" };
  const attachments: SnapshotMailAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { kind: "none" };
    const a = item as Record<string, unknown>;
    const filename = typeof a.filename === "string" ? a.filename.trim() : "";
    const mimeType = typeof a.mimeType === "string" ? a.mimeType.trim() : "";
    const bytes = typeof a.bytes === "number" && Number.isFinite(a.bytes) ? a.bytes : NaN;
    const contentSha256 = typeof a.contentSha256 === "string" ? a.contentSha256 : "";
    if (!filename || !mimeType || !Number.isFinite(bytes) || !/^[0-9a-f]{64}$/.test(contentSha256)) {
      return { kind: "none" };
    }
    attachments.push({
      filename,
      mimeType,
      bytes,
      contentSha256,
      sealed: a.sealed === true && typeof a.contentCiphertext === "string",
      contentCiphertext: typeof a.contentCiphertext === "string" ? a.contentCiphertext : undefined,
    });
  }
  return { kind: "present", attachments };
}

export function openSnapshotMailAttachmentBytes(
  attachment: SnapshotMailAttachment
): { ok: true; buffer: Buffer } | { ok: false; code: "mail_attachment_unavailable" | "mail_attachment_hash_mismatch" } {
  if (!attachment.sealed || !attachment.contentCiphertext) {
    return { ok: false, code: "mail_attachment_unavailable" };
  }
  let buffer: Buffer;
  try {
    buffer = decryptBytes(attachment.contentCiphertext);
  } catch {
    return { ok: false, code: "mail_attachment_unavailable" };
  }
  if (sha256(buffer) !== attachment.contentSha256 || buffer.length !== attachment.bytes) {
    return { ok: false, code: "mail_attachment_hash_mismatch" };
  }
  return { ok: true, buffer };
}

