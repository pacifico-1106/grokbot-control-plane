/**
 * /app/approvals の hold.release チケットは汎用承認 API では承認できない
 * （hold_release_web_only）。Web 専用の解除承認へ誘導するための判定と文言。
 *
 * 二人承認・AI 不可・再ログイン5分はここでは緩めない。実行は
 * POST /api/holds/release/approve → approveHoldRelease が担う。
 */
import { isHoldReleaseTicket } from "@/lib/safety/hold-config";

export const HOLD_RELEASE_APPROVE_PATH = "/api/holds/release/approve";

export const HOLD_RELEASE_WEB_ONLY_MESSAGE_JA =
  "緊急停止の解除は汎用の承認では行えません。この画面の『解除を承認』を押してください（ログインし直して5分以内）。";

const HOLD_RELEASE_ERROR_JA: Record<string, string> = {
  hold_release_web_only: HOLD_RELEASE_WEB_ONLY_MESSAGE_JA,
  fresh_login_required: "解除にはログインし直してください（5分以内のログインが必要です）。",
  session_unverified: "ログインを確認できません。ログインし直してください。",
  self_approval_denied: "申請した本人は承認できません。別の人が承認してください。",
  release_approver_not_allowed: "解除の承認はオーナーか指定管理者のみです。",
  ai_cannot_hold: "AI は緊急停止・解除を操作できません。人がダッシュボードから操作してください。",
  ops_hold_ops_only: "運営が止めた停止は運営のみが解除できます。",
  hold_not_found: "対象の緊急停止が見つかりません。",
  release_not_requested: "解除申請がありません。",
  release_ticket_invalid: "解除の承認チケットが無効です。",
  hold_store_failed: "解除を完了できませんでした。時間をおいてもう一度お試しください。",
  hold_required: "解除対象の停止が指定されていません。",
  hold_id_missing: "解除対象の停止が見つかりません。社員画面の緊急停止から承認してください。",
  auth_required: "ログインしてください。",
  hold_disabled: "緊急停止機能は無効です。",
  forbidden: "この操作はできません。",
  cross_origin_refused: "この操作は許可されていません。",
  json_required: "リクエストの形式が正しくありません。",
  not_found: "対象が見つかりません。",
  org_required: "組織を確認できません。ログインし直してください。",
};

const HOLD_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function holdReleaseHoldId(approval: { metadata?: Record<string, unknown> | null } | null | undefined): string {
  const raw = approval?.metadata?.holdId;
  if (typeof raw !== "string") return "";
  const id = raw.trim();
  return HOLD_ID_RE.test(id) ? id : "";
}

export type HoldReleaseApproveTarget =
  | { kind: "hold_release"; path: typeof HOLD_RELEASE_APPROVE_PATH; holdId: string }
  | { kind: "hold_release_missing_hold" }
  | { kind: "generic" };

export function holdReleaseApproveTarget(
  approval: { tool?: string | null; metadata?: Record<string, unknown> | null } | null | undefined,
  action: "approve" | "reject"
): HoldReleaseApproveTarget {
  if (action !== "approve" || !isHoldReleaseTicket(approval)) return { kind: "generic" };
  const holdId = holdReleaseHoldId(approval);
  return holdId
    ? { kind: "hold_release", path: HOLD_RELEASE_APPROVE_PATH, holdId }
    : { kind: "hold_release_missing_hold" };
}

function looksJapanese(text: string): boolean {
  return /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);
}

export function approvalDecideErrorJa(body: {
  message?: unknown;
  messageJa?: unknown;
  error?: unknown;
  reason?: unknown;
} | null | undefined): string {
  const messageJa = typeof body?.messageJa === "string" ? body.messageJa.trim() : "";
  if (messageJa) return messageJa;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (message && looksJapanese(message)) return message;
  const code = String(body?.error || body?.reason || "").trim();
  if (code && HOLD_RELEASE_ERROR_JA[code]) return HOLD_RELEASE_ERROR_JA[code];
  if (message) return message;
  return "操作に失敗しました。";
}

/** HTTP 200 でも ok:false は失敗（汎用承認が hold_release_web_only を握りつぶさない）。 */
export function approvalDecideFailed(resOk: boolean, body: { ok?: unknown } | null | undefined): boolean {
  return !resOk || body?.ok === false;
}
