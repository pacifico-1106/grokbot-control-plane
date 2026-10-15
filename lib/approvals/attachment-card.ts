/**
 * Approval card: which attachment is being approved (2026-10-04, #252 follow-up).
 *
 * Reads ONLY the snapshot's display fields (`metadata.invoke.fileAttachment`:
 * filename + bytes). The sealed reference, the reference host and the
 * reference hash are never read here, so no card / status output can show them.
 *
 *   present → "添付ファイル: <name>（<size>）"
 *   none    → "添付ファイル: なし"           (approved without an attachment)
 *   legacy / non-conversation tool → no line (nothing was recorded)
 *
 * Never part of the stored summary (#253 follow-up 5): Slack / Telegram / LINE
 * render the line on their own, Web renders `publicApproval().cardAttachment`
 * in its own element (components/approvals/ApprovalAttachmentNotice.tsx).
 *
 * The filename is agent-supplied: it is collapsed to one line, stripped of
 * bidi / zero-width controls and capped here; each surface escapes it again for
 * its own markup (Slack mrkdwn, Telegram HTML; Web / LINE render plain text).
 */
import { oneLineCardValue } from "@/lib/approvals/card-text";
import { snapshotAttachmentState } from "@/lib/approvals/snapshot-attachment";
import { snapshotMailAttachmentState } from "@/lib/approvals/snapshot-mail-attachments";

export const CARD_ATTACHMENT_LABEL = "添付ファイル";
export const CARD_FILENAME_MAX_CHARS = 100;

export type CardAttachmentFile = {
  filename: string;
  bytes?: number;
  sizeLabel?: string;
  mimeType?: string;
};

export type CardAttachment =
  | { kind: "present"; filename: string; bytes?: number; sizeLabel?: string; mimeType?: string; files?: CardAttachmentFile[] }
  | { kind: "none" };

// Bidi embeddings / overrides / isolates, zero-width and direction marks, BOM.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export function sanitizeCardFilename(value: string): string {
  const clean = oneLineCardValue(value.replace(INVISIBLE, ""));
  const chars = Array.from(clean);
  if (chars.length <= CARD_FILENAME_MAX_CHARS) return clean;
  return `${chars.slice(0, CARD_FILENAME_MAX_CHARS - 1).join("")}…`;
}

export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${units[unit]}`;
}

function presentFromFiles(files: CardAttachmentFile[]): CardAttachment {
  const first = files[0];
  if (!first) return { kind: "none" };
  return {
    kind: "present",
    filename: first.filename,
    ...(first.bytes !== undefined ? { bytes: first.bytes } : {}),
    ...(first.sizeLabel ? { sizeLabel: first.sizeLabel } : {}),
    ...(first.mimeType ? { mimeType: first.mimeType } : {}),
    ...(files.length > 1 ? { files } : {}),
  };
}

/** null = nothing recorded (legacy record or a tool without conversation attachments). */
export function readCardAttachment(metadata: Record<string, unknown> | null | undefined): CardAttachment | null {
  const invoke = metadata?.invoke;
  const mail = snapshotMailAttachmentState(invoke);
  if (mail.kind === "present") {
    const files = mail.attachments.map((att) => {
      const filename = sanitizeCardFilename(att.filename) || "attachment";
      const sizeLabel = formatAttachmentBytes(att.bytes) || undefined;
      return {
        filename,
        bytes: att.bytes,
        sizeLabel,
        mimeType: att.mimeType,
      };
    });
    return presentFromFiles(files);
  }
  const state = snapshotAttachmentState(invoke);
  if (state.kind === "legacy") return null;
  if (state.kind === "none") {
    // snapshotAttachmentState treats an unreadable object as "none"; a record
    // without the field at all is legacy (handled above).
    return { kind: "none" };
  }
  const filename = sanitizeCardFilename(state.attachment.filename);
  if (!filename) return { kind: "none" };
  const bytes = state.attachment.bytes;
  const sizeLabel = typeof bytes === "number" ? formatAttachmentBytes(bytes) || undefined : undefined;
  return { kind: "present", filename, ...(typeof bytes === "number" ? { bytes } : {}), ...(sizeLabel ? { sizeLabel } : {}) };
}

/**
 * The card line with the filename rendered by `renderName` (surface escaping).
 * Plain text by default (Web summary, LINE).
 */
function formatPresentFile(
  file: CardAttachmentFile,
  renderName: (name: string) => string
): string {
  const typeAndSize = [file.mimeType, file.sizeLabel].filter(Boolean).join(", ");
  return `${renderName(file.filename)}${typeAndSize ? `（${typeAndSize}）` : ""}`;
}

export function attachmentCardLine(card: CardAttachment, renderName: (name: string) => string = (n) => n): string {
  if (card.kind === "none") return `${CARD_ATTACHMENT_LABEL}: なし`;
  const files = card.files && card.files.length > 0
    ? card.files
    : [{ filename: card.filename, bytes: card.bytes, sizeLabel: card.sizeLabel, mimeType: card.mimeType }];
  if (files.length === 1) {
    return `${CARD_ATTACHMENT_LABEL}: ${formatPresentFile(files[0]!, renderName)}`;
  }
  return [`${CARD_ATTACHMENT_LABEL}:`, ...files.map((f) => `- ${formatPresentFile(f, renderName)}`)].join("\n");
}

/** The plain card line, or null when nothing was recorded. */
export function attachmentSummaryLine(metadata: Record<string, unknown> | null | undefined): string | null {
  const card = readCardAttachment(metadata);
  return card ? attachmentCardLine(card) : null;
}

/** Fixed last line of buildRichApprovalSummary (lib/approvals/summary.ts). */
const SUMMARY_FOOTER_PREFIX = "Staffpass 承認後にのみ";

/**
 * Summaries stored while #253's builder still added the card line (the builder
 * no longer does, #253 follow-up 5): hide that one line, because every surface
 * renders the attachment on its own. Only the builder position counts — the
 * line right before "本文:" (or before the fixed footer when there is no body)
 * — so the same text written inside the message body is never removed.
 */
export function withoutAttachmentSummaryLine(summary: string, metadata: Record<string, unknown> | null | undefined): string {
  const line = attachmentSummaryLine(metadata);
  if (!line) return summary;
  const lines = summary.split("\n");
  const bodyAt = lines.indexOf("本文:");
  const at = bodyAt >= 0
    ? bodyAt - 1
    : lines.findIndex((l) => l.startsWith(SUMMARY_FOOTER_PREFIX)) - 1;
  if (at < 0 || lines[at] !== line) return summary;
  lines.splice(at, 1);
  return lines.join("\n");
}

/** Status / MCP output: `{ filename, bytes?, sizeLabel? }`, or null (none / not recorded). */
export function attachmentStatusField(
  metadata: Record<string, unknown> | null | undefined
): { filename: string; bytes?: number; sizeLabel?: string } | null {
  const card = readCardAttachment(metadata);
  if (!card || card.kind !== "present") return null;
  return {
    filename: card.filename,
    ...(card.bytes !== undefined ? { bytes: card.bytes } : {}),
    ...(card.sizeLabel ? { sizeLabel: card.sizeLabel } : {}),
    ...(card.mimeType ? { mimeType: card.mimeType } : {}),
    ...(card.files && card.files.length > 1 ? { files: card.files } : {}),
  };
}
