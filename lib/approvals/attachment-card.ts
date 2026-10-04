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
 * The filename is agent-supplied: it is collapsed to one line, stripped of
 * bidi / zero-width controls and capped here; each surface escapes it again for
 * its own markup (Slack mrkdwn, Telegram HTML; Web / LINE render plain text).
 */
import { oneLineCardValue } from "@/lib/approvals/summary";
import { snapshotAttachmentState } from "@/lib/approvals/snapshot-attachment";

export const CARD_ATTACHMENT_LABEL = "添付ファイル";
export const CARD_FILENAME_MAX_CHARS = 100;

export type CardAttachment =
  | { kind: "present"; filename: string; bytes?: number; sizeLabel?: string }
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

/** null = nothing recorded (legacy record or a tool without conversation attachments). */
export function readCardAttachment(metadata: Record<string, unknown> | null | undefined): CardAttachment | null {
  const invoke = metadata?.invoke;
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
export function attachmentCardLine(card: CardAttachment, renderName: (name: string) => string = (n) => n): string {
  if (card.kind === "none") return `${CARD_ATTACHMENT_LABEL}: なし`;
  return `${CARD_ATTACHMENT_LABEL}: ${renderName(card.filename)}${card.sizeLabel ? `（${card.sizeLabel}）` : ""}`;
}

/** Plain line for the stored summary, or null when nothing was recorded. */
export function attachmentSummaryLine(metadata: Record<string, unknown> | null | undefined): string | null {
  const card = readCardAttachment(metadata);
  return card ? attachmentCardLine(card) : null;
}

/** Remove the plain line from a summary when the surface renders it on its own. */
export function withoutAttachmentSummaryLine(summary: string, metadata: Record<string, unknown> | null | undefined): string {
  const line = attachmentSummaryLine(metadata);
  if (!line) return summary;
  return summary.split("\n").filter((l) => l !== line).join("\n");
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
  };
}
