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
  employee_policy_update_failed: "保存に失敗しました（変更は反映していません）。時間をおいてもう一度お試しください",
  employee_policy_credentials_update_failed:
    "社員証への反映に失敗したため、変更を元に戻しました。時間をおいてもう一度お試しください",
};

export type EmployeePolicyWriteFailureCode =
  | "employee_policy_update_failed"
  | "employee_policy_credentials_update_failed";

export type EmployeePolicyWriteFailure = {
  code: EmployeePolicyWriteFailureCode;
  /** Only for credentials failures: whether employees was put back. */
  rolledBack?: boolean;
  /** Dashboard message (Japanese, no storage detail). */
  messageJa: string;
  /** Admin MCP next step (Japanese, no storage detail). */
  nextStepJa: string;
};

/**
 * Map an error thrown by updateEmployeePolicy (EmployeePolicyWriteError, or
 * anything unexpected) to a code + Japanese text for callers. Fail-closed:
 * every error is a failure; the storage detail (error.message) is never
 * returned — log it server-side instead.
 */
export function employeePolicyWriteFailure(error: unknown): EmployeePolicyWriteFailure {
  const rec = (error && typeof error === "object" ? error : {}) as { code?: unknown; rolledBack?: unknown };
  if (rec.code === "employee_policy_credentials_update_failed") {
    if (rec.rolledBack === true) {
      return {
        code: rec.code,
        rolledBack: true,
        messageJa: POLICY_ERROR_MESSAGES.employee_policy_credentials_update_failed,
        nextStepJa: "社員証への反映に失敗したため、変更を元に戻しました（変更していません）。時間をおいて、もう一度依頼してください。",
      };
    }
    return {
      code: rec.code,
      rolledBack: false,
      messageJa: "社員証への反映に失敗し、元に戻すこともできませんでした。画面を再読み込みして、現在の設定を確認してください",
      nextStepJa:
        "社員証への反映に失敗し、元に戻すこともできませんでした。ダッシュボードの AI 社員ページで現在の設定を確認してください。",
    };
  }
  if (rec.code === "employee_policy_update_failed") {
    return {
      code: rec.code,
      messageJa: POLICY_ERROR_MESSAGES.employee_policy_update_failed,
      nextStepJa: "保存に失敗したため、変更していません。時間をおいて、もう一度依頼してください。",
    };
  }
  // Unexpected error: we cannot tell what was applied.
  return {
    code: "employee_policy_update_failed",
    messageJa: "保存に失敗しました。画面を再読み込みして、現在の設定を確認してください",
    nextStepJa: "保存に失敗しました。ダッシュボードの AI 社員ページで現在の設定を確認してください。",
  };
}

/** JSON body for a dashboard route (same shape as policyErrorPayload + rolledBack). */
export function employeePolicyWriteFailurePayload(
  failure: EmployeePolicyWriteFailure
): { error: string; message: string; rolledBack?: boolean } {
  return {
    ...policyErrorPayload(failure.code, failure.messageJa),
    ...(failure.rolledBack !== undefined ? { rolledBack: failure.rolledBack } : {}),
  };
}

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
