/**
 * comm.delete target: which message to delete. Taken from args ONLY (never
 * from conversation{}: that describes the wake, not the post to delete).
 *
 * Shape (every surface): { surface?, channel, messageId }.
 * Slack: channel = C… / G… / D… id, messageId = message ts (`ts` alias).
 * LINE / Telegram: chat id + message id (accepted so the answer can be an
 * explicit not_supported with the reason).
 */
import { COMM_DELETE_SURFACES, type CommDeleteSurface } from "./surfaces";

export type CommDeleteTarget = { surface: CommDeleteSurface; channel: string; messageId: string };

export type CommDeleteTargetParse =
  | { ok: true; target: CommDeleteTarget }
  | { ok: false; code: "invalid_delete_target"; field: string; messageJa: string };

const SLACK_CONVERSATION_ID = /^[CDG][A-Z0-9_]{2,31}$/;
const SLACK_TS = /^\d{9,11}\.\d{1,8}$/;
const GENERIC_ID = /^[A-Za-z0-9_\-:.@]{1,128}$/;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function invalid(field: string, messageJa: string): CommDeleteTargetParse {
  return { ok: false, code: "invalid_delete_target", field, messageJa };
}

export function parseCommDeleteTarget(args: Record<string, unknown> | undefined | null): CommDeleteTargetParse {
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const surfaceRaw = str(a.surface).toLowerCase() || "slack";
  if (!(COMM_DELETE_SURFACES as readonly string[]).includes(surfaceRaw)) {
    return invalid("surface", "surface は slack / line / telegram のいずれかを指定してください。");
  }
  const surface = surfaceRaw as CommDeleteSurface;
  const channel = str(a.channel) || str(a.channelId) || str(a.slackChannelId) || str(a.chatId);
  const messageId = str(a.messageId) || str(a.ts) || str(a.message_id);
  if (!channel) return invalid("channel", "削除する投稿のチャネル（channel）を指定してください。");
  if (!messageId) return invalid("messageId", "削除する投稿の ID（Slack は ts、ほかは messageId）を指定してください。");
  if (surface === "slack") {
    if (!SLACK_CONVERSATION_ID.test(channel)) {
      return invalid("channel", "Slack の channel は C… / G… / D… の ID で指定してください（ユーザーID は不可）。");
    }
    if (!SLACK_TS.test(messageId)) return invalid("messageId", "Slack の ts の形式が正しくありません。");
  } else if (!GENERIC_ID.test(channel) || !GENERIC_ID.test(messageId)) {
    return invalid("channel", "channel / messageId の形式が正しくありません。");
  }
  return { ok: true, target: { surface, channel, messageId } };
}

/** What the human approved: saved on the approval as metadata.commDeleteTarget when the card was created. */
export type ApprovedCommDeleteTarget = { target: CommDeleteTarget; employeeId: string };

/**
 * Strictly read metadata.commDeleteTarget. Anything other than a plain object
 * with string surface / channel / messageId / employeeId that is already in
 * canonical form (re-parses to exactly the same values) is rejected: the
 * approved target is never repaired or guessed.
 */
export function parseApprovedCommDeleteTarget(raw: unknown): ApprovedCommDeleteTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const { surface, channel, messageId, employeeId } = r;
  if (typeof surface !== "string" || typeof channel !== "string" || typeof messageId !== "string") return null;
  if (typeof employeeId !== "string" || !employeeId.trim() || employeeId !== employeeId.trim()) return null;
  const parsed = parseCommDeleteTarget({ surface, channel, messageId });
  if (!parsed.ok) return null;
  const t = parsed.target;
  if (t.surface !== surface || t.channel !== channel || t.messageId !== messageId) return null;
  return { target: t, employeeId };
}
