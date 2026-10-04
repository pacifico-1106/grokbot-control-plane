/**
 * Approval snapshot for a conversation tool's fileAttachment (2026-10-04, #252).
 *
 * The approver approves a text AND (optionally) one attachment. A re-run after
 * approval must upload only that attachment, never whatever the re-run request
 * carries — the same contract as the approved text.
 *
 * Stored at `metadata.invoke.fileAttachment`:
 *   - absent  → legacy record (created before this contract); attachment unknown
 *   - null    → approved with NO attachment
 *   - object  → `SnapshotAttachment` below
 *
 * What is stored (and why):
 *   - filename / mimeType / bytes / title / initialComment: what the approver saw.
 *   - refKind + refHost (URL hostname only) + refSha256: identify the reference
 *     for audit and change detection without keeping a readable signed URL.
 *   - fileRefCiphertext: the reference itself, sealed with the same AES-256-GCM
 *     store as adapter secrets (NOTIFICATION_CONFIG_ENCRYPTION_KEY). Needed so the
 *     approved file can actually be fetched at re-run; redacted from every
 *     public approval view (lib/data/redaction.ts).
 *   - sealed: false when the key is unavailable — then NO reference is kept and
 *     the re-run fails the upload closed (approval_attachment_unavailable).
 * Never stored: the file body, a plain URL / query string, any token.
 */
import { createHash } from "node:crypto";
import {
  decryptNotificationSecrets,
  encryptNotificationSecrets,
} from "@/lib/notify/crypto";
import type { GatewayInvokeRequest } from "@/lib/types";

export type RequestFileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;

export type SnapshotAttachment = {
  filename: string;
  mimeType?: string;
  bytes?: number;
  title?: string;
  initialComment?: string;
  refKind: "url" | "ref";
  refHost?: string;
  refSha256: string;
  sealed: boolean;
  fileRefCiphertext?: string;
};

export type SnapshotAttachmentState =
  | { kind: "legacy" }
  | { kind: "none" }
  | { kind: "present"; attachment: SnapshotAttachment };

const MAX_TEXT = 1_000;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined;

/** A request "has an attachment" as soon as it sends a fileAttachment object (fail-closed). */
export function requestHasAttachment(body: GatewayInvokeRequest | undefined | null): boolean {
  const raw = body?.fileAttachment as unknown;
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
}

function refHost(ref: string): string | undefined {
  try {
    return new URL(ref).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot value for the request: object, or null when there is no usable attachment. */
export function buildSnapshotAttachment(
  attachment: GatewayInvokeRequest["fileAttachment"] | undefined
): SnapshotAttachment | null {
  const fileRef = text(attachment?.fileRef) ? String(attachment!.fileRef).trim() : "";
  const filename = text(attachment?.filename);
  if (!attachment || !fileRef || !filename) return null;
  const isUrl = /^https?:\/\//i.test(fileRef);
  const snapshot: SnapshotAttachment = {
    filename,
    refKind: isUrl ? "url" : "ref",
    refSha256: sha256(fileRef),
    sealed: false,
  };
  const mimeType = text(attachment.mimeType);
  if (mimeType) snapshot.mimeType = mimeType;
  if (typeof attachment.bytes === "number" && Number.isFinite(attachment.bytes) && attachment.bytes >= 0) {
    snapshot.bytes = attachment.bytes;
  }
  const title = text(attachment.title);
  if (title) snapshot.title = title;
  const initialComment = text(attachment.initialComment);
  if (initialComment) snapshot.initialComment = initialComment;
  const host = isUrl ? refHost(fileRef) : undefined;
  if (host) snapshot.refHost = host;
  try {
    snapshot.fileRefCiphertext = encryptNotificationSecrets({ fileRef });
    snapshot.sealed = true;
  } catch {
    // No key: keep metadata only. The re-run cannot fetch it and fails closed.
  }
  return snapshot;
}

/** legacy (field absent) / none (null) / present. Malformed values are "none" (never upload). */
export function snapshotAttachmentState(invoke: unknown): SnapshotAttachmentState {
  if (!invoke || typeof invoke !== "object" || Array.isArray(invoke)) return { kind: "legacy" };
  const rec = invoke as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rec, "fileAttachment")) return { kind: "legacy" };
  const raw = rec.fileAttachment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "none" };
  const a = raw as Record<string, unknown>;
  const filename = text(a.filename);
  const refSha256 = typeof a.refSha256 === "string" ? a.refSha256 : "";
  if (!filename || !refSha256) return { kind: "none" };
  return {
    kind: "present",
    attachment: {
      filename,
      mimeType: text(a.mimeType),
      bytes: typeof a.bytes === "number" && Number.isFinite(a.bytes) ? a.bytes : undefined,
      title: text(a.title),
      initialComment: text(a.initialComment),
      refKind: a.refKind === "url" ? "url" : "ref",
      refHost: text(a.refHost),
      refSha256,
      sealed: a.sealed === true && typeof a.fileRefCiphertext === "string",
      fileRefCiphertext: typeof a.fileRefCiphertext === "string" ? a.fileRefCiphertext : undefined,
    },
  };
}

/** The sealed reference, only when it decrypts AND matches the recorded hash. */
export function openSnapshotAttachmentRef(attachment: SnapshotAttachment): string | null {
  if (!attachment.sealed || !attachment.fileRefCiphertext) return null;
  try {
    const ref = decryptNotificationSecrets(attachment.fileRefCiphertext).fileRef || "";
    return ref && sha256(ref) === attachment.refSha256 ? ref : null;
  } catch {
    return null;
  }
}

/** Does the request attachment equal the approved one (reference + filename)? */
export function requestMatchesSnapshotAttachment(
  request: GatewayInvokeRequest["fileAttachment"] | undefined,
  snapshot: SnapshotAttachment
): boolean {
  const ref = typeof request?.fileRef === "string" ? request.fileRef.trim() : "";
  return Boolean(ref) && sha256(ref) === snapshot.refSha256 &&
    text(request?.filename) === snapshot.filename;
}

/** Audit-safe description of a request attachment (hash + filename, never the ref). */
export function describeRequestAttachment(request: GatewayInvokeRequest["fileAttachment"] | undefined) {
  const ref = typeof request?.fileRef === "string" ? request.fileRef.trim() : "";
  return {
    requestFilename: text(request?.filename),
    requestRefSha256: ref ? sha256(ref) : undefined,
  };
}
