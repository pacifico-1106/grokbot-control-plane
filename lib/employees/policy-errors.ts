const JP = /[\u3040-\u30ff\u3400-\u9fff]/;

export const POLICY_ERROR_MESSAGES: Record<string, string> = {
  sod_ack_required: "警告を確認してから保存してください",
  allowed_accounts_required: "ブラウザ利用には許可アカウントが必要です",
  invalid_policy: "権限の内容が正しくありません",
  employee_not_found: "AI社員が見つかりません",
  employee_terminated: "契約終了済みのAI社員は更新できません",
  auth_required: "ログインが必要です",
  invalid_identity: "表示名または職務ラベルが正しくありません",
  connect_cannot_be_internal: "Slack Connect / 社外混在は社内にできません",
  slack_identity_unbound: "本人として出すには、社員証で Slack 連携が必要です",
  interpret_failed: "職務の読み取りに失敗しました",
  issue_failed: "社員証の発行に失敗しました",
  name_and_role_required: "名前と職務は必須です",
  scopes_required: "できることを1つ以上選んでください",
  input_required: "職務の説明を入力してください",
  input_too_long: "職務の説明が長すぎます",
  sensitive_input_not_allowed: "秘密情報は入力しないでください",
  capability_denied: "この操作をする権限がありません",
  slack_oauth_unconfigured: "Slack アプリの OAuth が未設定です",
  invalid_wake_webhook_url: "起こす webhook の URL が正しくありません",
  wake_webhook_url_required: "起こす webhook の URL が必要です",
  approval_channel_not_found: "指定の承認インボックスが見つかりません",
  admin_mcp_required: "権限（できること・使う理由・行為上限）の変更は管理MCPの人承認です",
  directory_admin_mcp_required: "相手台帳の変更は管理MCPの人承認です",
};

export function looksJapanese(value: string): boolean {
  return JP.test(value);
}

export function policyErrorPayload(
  error: string,
  message?: string
): { error: string; message: string } {
  const mapped = POLICY_ERROR_MESSAGES[error];
  const explicit = message?.trim() || "";
  return {
    error,
    message: explicit || mapped || "保存に失敗しました",
  };
}

/**
 * UI helper: prefer an already-Japanese `message`, else map `error` codes,
 * else a generic save failure.
 */
export function policyErrorMessage(
  body: unknown,
  fallback = "保存に失敗しました"
): string {
  if (!body || typeof body !== "object") return fallback;
  const rec = body as { error?: unknown; message?: unknown };
  const message = typeof rec.message === "string" ? rec.message.trim() : "";
  if (message && looksJapanese(message)) return message;
  const error = typeof rec.error === "string" ? rec.error.trim() : "";
  if (error && POLICY_ERROR_MESSAGES[error]) return POLICY_ERROR_MESSAGES[error];
  if (error && looksJapanese(error)) return error;
  if (message) return message;
  return fallback;
}
