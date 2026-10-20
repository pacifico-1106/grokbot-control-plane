/**
 * /api/mcp auth-failure kinds + Japanese 401 next-step (flags default OFF).
 *
 * MCP_AUTH_401_NEXT_STEP_JA_ENABLED: add data.nextStepJa. Machine-readable
 * data.code is unchanged. Missing/empty vs expired are distinct Japanese
 * texts; invalid and revoked share the same Japanese text so the 401/403
 * body does not reveal whether a credential exists. Expired never includes
 * employee / org / credential ids.
 *
 * MCP_AUTH_FAILURE_AUDIT_ENABLED lives in lib/feature-flags.ts and is applied
 * by lib/data/mcp-auth-failures.ts.
 */
import { isMcpAuth401NextStepJaEnabled } from "@/lib/feature-flags";

export type McpAuthFailureKind = "missing_credential" | "invalid" | "expired";

export function mcpAuthFailureKind(code: string | null | undefined): McpAuthFailureKind | null {
  if (code === "missing_credential") return "missing_credential";
  if (code === "invalid_credential") return "invalid";
  if (code === "expired") return "expired";
  return null;
}

export { isMcpAuth401NextStepJaEnabled };

const MISSING_JA =
  "社員証（gb_emp_…）がサーバーに届いていません。環境変数や MCP 設定の認証情報が空、または起動直後でまだセットされていないことがあります。設定を確認してクライアントを再起動してください。";

const INVALID_JA =
  "社員証を確認できませんでした。環境変数や MCP 設定の認証情報を確認し、クライアントを再起動してください。";

const EXPIRED_JA =
  "社員証の有効期限が切れています。新しい社員証を再発行してください。" +
  "credential 管理権限のある人がダッシュボード /app/employees を開き、社員証を再発行して一度だけ表示された鍵（gb_emp_…）を MCP 設定に入れ、" +
  "クライアントを再起動してください。チャットに貼らないでください。";

export function mcpAuth401NextStepJa(
  code: string | null | undefined,
  _ctx: { employeeId?: string | null } = {}
): string | null {
  void _ctx;
  const kind = mcpAuthFailureKind(code);
  if (kind === "missing_credential") return MISSING_JA;
  if (kind === "expired") return EXPIRED_JA;
  if (kind === "invalid" || code === "revoked") return INVALID_JA;
  return null;
}

/** data.code stays the same; nextStepJa only when the JA flag is ON. */
export function mcpAuthFailureErrorData(
  auth: { code: string; employeeId?: string | null },
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const errorData: Record<string, unknown> = { code: auth.code, ...extra };
  if (isMcpAuth401NextStepJaEnabled()) {
    const ja = mcpAuth401NextStepJa(auth.code);
    if (ja) errorData.nextStepJa = ja;
  }
  return errorData;
}
