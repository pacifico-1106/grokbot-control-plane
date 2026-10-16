/**
 * /api/mcp auth-failure kinds + Japanese 401 next-step (flags default OFF).
 *
 * MCP_AUTH_401_NEXT_STEP_JA_ENABLED: add data.nextStepJa. Machine-readable
 * data.code is unchanged. Missing/empty vs expired are distinct Japanese
 * texts; invalid does not say whether a matching 社員証 exists.
 *
 * MCP_AUTH_FAILURE_AUDIT_ENABLED lives in lib/feature-flags.ts and is applied
 * by lib/data/mcp-auth-failures.ts.
 */
import { isMcpAuth401NextStepJaEnabled } from "@/lib/feature-flags";

export type McpAuthFailureKind = "missing_credential" | "invalid" | "expired";

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

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

function expiredJa(employeeId?: string | null): string {
  const path =
    employeeId && SAFE_ID.test(employeeId)
      ? `/app/employees/${employeeId}`
      : "/app/employees";
  return (
    `社員証の有効期限が切れています。新しい社員証を再発行してください。` +
    `credential 管理権限のある人がダッシュボード ${path} を開き、社員証を再発行して一度だけ表示された鍵（gb_emp_…）を MCP 設定に入れ、` +
    `クライアントを再起動してください。チャットに貼らないでください。`
  );
}

export function mcpAuth401NextStepJa(
  code: string | null | undefined,
  ctx: { employeeId?: string | null } = {}
): string | null {
  const kind = mcpAuthFailureKind(code);
  if (kind === "missing_credential") return MISSING_JA;
  if (kind === "expired") return expiredJa(ctx.employeeId);
  if (kind === "invalid") return INVALID_JA;
  return null;
}

/** data.code stays the same; nextStepJa only when the JA flag is ON. */
export function mcpAuthFailureErrorData(
  auth: { code: string; employeeId?: string | null },
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const errorData: Record<string, unknown> = { code: auth.code, ...extra };
  if (isMcpAuth401NextStepJaEnabled()) {
    const ja = mcpAuth401NextStepJa(auth.code, { employeeId: auth.employeeId });
    if (ja) errorData.nextStepJa = ja;
  }
  return errorData;
}
