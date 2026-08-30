const JP = /[\u3040-\u30ff\u3400-\u9fff]/;

export const CHANNEL_ERROR_MESSAGES: Record<string, string> = {
  invalid_provider: "通知チャネルの種類が正しくありません",
  destination_required: "送信先を入力してください",
  enabled_channel_not_found: "有効な承認インボックスが見つかりません",
  telegram_credentials_incomplete: "Telegram の Bot token が不足しています",
  line_credentials_incomplete: "LINE のチャネル情報が不足しています",
  slack_credentials_incomplete: "Slack の Bot token または Signing secret が不足しています",
  notification_credentials_required: "有効にするには認証情報を入力してください",
  notification_channel_save_failed: "承認インボックスの保存に失敗しました",
  notification_channel_secret_save_failed: "認証情報の保存に失敗しました",
  supabase_not_configured: "保存先が設定されていません",
};

function looksJapanese(value: string): boolean {
  return JP.test(value);
}

export function channelErrorPayload(
  error: string,
  message?: string
): { error: string; message: string } {
  const mapped = CHANNEL_ERROR_MESSAGES[error];
  const explicit = message?.trim() || "";
  return {
    error,
    message: explicit || mapped || "保存に失敗しました",
  };
}

export function channelErrorMessage(
  body: unknown,
  fallback = "保存に失敗しました"
): string {
  if (!body || typeof body !== "object") return fallback;
  const rec = body as { error?: unknown; message?: unknown };
  const message = typeof rec.message === "string" ? rec.message.trim() : "";
  if (message && looksJapanese(message)) return message;
  const error = typeof rec.error === "string" ? rec.error.trim() : "";
  if (error && CHANNEL_ERROR_MESSAGES[error]) return CHANNEL_ERROR_MESSAGES[error];
  if (error && looksJapanese(error)) return error;
  if (message) return message;
  return fallback;
}
