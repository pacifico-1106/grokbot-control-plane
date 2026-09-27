/**
 * Ephemeral rejection messages for Slack approval buttons.
 * P0 Item 3: Send user-friendly rejection messages to the presser.
 *
 * Security:
 * - Never exposes secrets in messages
 * - Never reveals internal error details to external users
 * - Japanese user-facing messages with generic rejection reasons
 */

const SLACK_TIMEOUT_MS = 5_000;

export type SlackRejectionReason =
  | "expected_team_id_not_configured"
  | "external_team_user"
  | "not_in_allowed_list"
  | "not_in_voter_binding"
  | "card_expired"
  | "delivery_mismatch"
  | "self_approval_denied"
  | "voter_binding_failed"
  | "signature_invalid"
  | "app_mismatch"
  | "team_mismatch";

const REJECTION_MESSAGES_JA: Record<SlackRejectionReason, string> = {
  expected_team_id_not_configured:
    "このチャンネルは正しく設定されていません。管理者にお問い合わせください。",
  external_team_user:
    "外部ワークスペースのユーザーは承認操作を行えません。",
  not_in_allowed_list:
    "このチケットを承認する権限がありません。",
  not_in_voter_binding:
    "承認者として登録されていません。管理者にバインディングを依頼してください。",
  card_expired:
    "この承認カードは期限切れまたは既に処理済みです。",
  delivery_mismatch:
    "この承認カードは対象の承認リクエストと一致しません。",
  self_approval_denied:
    "自分自身が作成したリクエストは承認できません。",
  voter_binding_failed:
    "承認者登録の確認に失敗しました。",
  signature_invalid:
    "リクエストの検証に失敗しました。",
  app_mismatch:
    "アプリの設定が一致しません。",
  team_mismatch:
    "ワークスペースの設定が一致しません。",
};

export async function sendEphemeralRejection(
  responseUrl: string,
  reason: SlackRejectionReason,
  customMessage?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!responseUrl?.trim()) {
    return { ok: false, error: "no_response_url" };
  }

  const message =
    customMessage ||
    REJECTION_MESSAGES_JA[reason] ||
    "リクエストを処理できませんでした。";

  try {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: false,
        text: `❌ ${message}`,
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { ok: false, error: `http_${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "send_failed",
    };
  }
}

export function getRejectionMessageJa(reason: SlackRejectionReason): string {
  return REJECTION_MESSAGES_JA[reason] || "リクエストを処理できませんでした。";
}
