/**
 * SLACK_AUTHORIZE_LINK_ENABLED: shared, dependency-free texts / helpers for the
 * re-authorize link (used by lib/slack/authorize-link.ts and the read-only
 * setup.slackDmApprovalStatus diagnosis without a circular import).
 */
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { isSlackDmAutorouteEnabled } from "@/lib/slack/dm-autoroute-flags";
import type { Employee } from "@/lib/types";

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;

/** Slack U… entries in the badge's allowedAccounts (service=slack, valid id). */
export function allowedSlackAccountIds(employee: Pick<Employee, "allowedAccounts">): string[] {
  return normalizeAllowedAccounts(employee.allowedAccounts)
    .filter((row) => row.service.toLowerCase() === "slack" && SLACK_USER_ID_RE.test(row.accountId))
    .map((row) => row.accountId);
}

/** Admin MCP tool that adds an allowed account (shipped by a separate PR). */
export const ALLOWED_ACCOUNTS_ADD_TOOL = "employees.allowedAccounts.add";

/**
 * Next step when the badge has no Slack account in allowedAccounts and
 * ALLOWED_ACCOUNTS_ADD_TOOL is NOT registered: no admin MCP tool edits
 * allowedAccounts of an existing badge (employees.issue sets them only at issue
 * time; policy.patch does not touch them) → dashboard employee page (human).
 */
export const ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA =
  "社員証の許可アカウント（allowedAccounts）に Slack の U… を追加してください。" +
  "管理 MCP には既存の社員証の allowedAccounts を編集するツールはありません（policy.patch は allowedAccounts を変更しません）。" +
  "ダッシュボードの AI 社員ページ「ブラウザ・外部アカウント」で、人が Slack を選び社員本人の U… を入れて保存してください。" +
  "保存後に setup.slackAuthorizeLink.issue をもう一度呼んでください。";

/** Next step when ALLOWED_ACCOUNTS_ADD_TOOL is registered in the admin tool registry. */
export const ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_TOOL_JA =
  `${ALLOWED_ACCOUNTS_ADD_TOOL} で Slack の U… を追加してから、もう一度 setup.slackAuthorizeLink.issue で発行してください。`;

/**
 * Runtime check: advertised (ADMIN_MCP_TOOL_NAMES) AND defined/callable
 * (ADMIN_MCP_TOOLS). Lazy import keeps this module free of a load-time cycle
 * (admin-tools → … → authorize-link → here). Never throws.
 */
export async function isAdminMcpToolRegistered(name: string): Promise<boolean> {
  try {
    if (!(ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name)) return false;
    const { ADMIN_MCP_TOOLS } = await import("@/lib/mcp/admin-tools");
    return ADMIN_MCP_TOOLS.some((tool) => tool.name === name);
  } catch {
    return false;
  }
}

/**
 * THE allowedAccounts-without-Slack next step (issue error + status). Works
 * whether #240 or the employees.allowedAccounts.* PR merges first.
 */
/**
 * 追記 4: #242's ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED (default OFF; OFF →
 * employees.allowedAccounts.* do nothing). Read here with the SAME parsing as
 * #242's isEmployeesAllowedAccountsAdminToolAvailable() (trim + lowercase;
 * true / 1 / on / enabled) instead of importing it, so #240 works whether or
 * not #242 is merged.
 */
export const ALLOWED_ACCOUNTS_TOOLS_FLAG = "ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isAllowedAccountsAdminToolsFlagOn(): boolean {
  return parseFlag(process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG]);
}

export async function resolveAllowedAccountsSlackNextStep(): Promise<{
  nextStepJa: string;
  allowedAccountsAdminTool: string | null;
}> {
  // Registered (name + definition) AND the flag ON → the tool actually works.
  return isAllowedAccountsAdminToolsFlagOn() && (await isAdminMcpToolRegistered(ALLOWED_ACCOUNTS_ADD_TOOL))
    ? { nextStepJa: ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_TOOL_JA, allowedAccountsAdminTool: ALLOWED_ACCOUNTS_ADD_TOOL }
    : { nextStepJa: ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA, allowedAccountsAdminTool: null };
}

/**
 * Every callback outcome AFTER the atomic consume that ends without a bind
 * (the link stays used). Each one DMs the recipient (+ approver when the link
 * went to the employee) and shows the "burned" page — one template, the code
 * is the only variable.
 */
export const AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS = [
  "oauth_exchange_failed",
  "user_token_missing",
  "auth_test_failed",
  "team_mismatch",
  "user_mismatch",
  "allowed_accounts_mismatch",
  "bind_failed",
] as const;
export type AuthorizeLinkConsumedFailureReason = (typeof AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS)[number];

export function isAuthorizeLinkConsumedFailureReason(code: string): code is AuthorizeLinkConsumedFailureReason {
  return (AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS as readonly string[]).includes(code);
}

function safeReasonCode(code: string | null | undefined): string {
  const raw = (code || "").trim();
  return /^[a-z0-9_]{1,64}$/.test(raw) ? raw : "unknown";
}

/** Recipient DM + result page (single template; only the code varies). */
export function authorizeLinkFailedNoticeJa(code: string | null | undefined): string {
  return `再認可リンクが別のアカウントで開かれた（または認可に失敗した）ため無効になりました（${safeReasonCode(code)}）。管理者に再発行を依頼してください。`;
}

/** Approver DM when the failed link had been delivered to the employee. */
export function authorizeLinkApproverFailureNoticeJa(employeeName: string, code: string | null | undefined): string {
  return `社員「${employeeName}」の再認可リンクが失敗しました（${safeReasonCode(code)}）。再発行してください`;
}

/**
 * 追記 3: work that runs AFTER the identity is saved. Each step has its own
 * try; one failing never skips the rest, never sends the burned-link notice,
 * and never turns the result page into an error. Any failure →
 * `slack_authorize_link.completed_with_errors` (step names + reason codes only).
 */
export const AUTHORIZE_LINK_FOLLOW_UP_STEPS = ["link_status", "completed_audit", "completion_notice", "dm_autoroute"] as const;
export type AuthorizeLinkFollowUpStep = (typeof AUTHORIZE_LINK_FOLLOW_UP_STEPS)[number];

/** Real admin MCP tool (lib/mcp/admin-tools.ts) that re-runs the #234 DM auto-route. */
export const DM_AUTOROUTE_RUN_TOOL = "dmAutoroute.run";

/**
 * nextStep for completed_with_errors (audit + setup.slackDmApprovalStatus).
 * Registry-checked at runtime: never names a tool that is not callable.
 */
export async function resolveAuthorizeLinkFollowUpNextStep(
  employeeId: string,
  failedSteps: readonly string[]
): Promise<{ nextStepJa: string; recoveryAdminTool: string | null }> {
  const noticeNote = failedSteps.includes("completion_notice")
    ? "完了の DM は届いていない可能性があります（Slack 連携そのものは完了しています）。"
    : "";
  // 追記 4: dmAutoroute.run dryRun:false refuses with dm_autoroute_flag_off
  // unless SLACK_DM_AUTOROUTE_ENABLED is ON → only then name it.
  if (isSlackDmAutorouteEnabled() && (await isAdminMcpToolRegistered(DM_AUTOROUTE_RUN_TOOL))) {
    return {
      nextStepJa:
        `Slack 連携は完了しています。後続の処理は ${DM_AUTOROUTE_RUN_TOOL}（employeeId=${employeeId}, dryRun:false）で後から取り戻せます` +
        `（人の承認 1 回。先に dryRun:true で確認できます）。${noticeNote}`,
      recoveryAdminTool: DM_AUTOROUTE_RUN_TOOL,
    };
  }
  if (!isSlackDmAutorouteEnabled()) {
    // Flag OFF: no DM auto-route ran or can run now; nothing to re-run.
    return { nextStepJa: `Slack 連携は完了しています。${noticeNote}`.trim(), recoveryAdminTool: null };
  }
  return {
    nextStepJa: `Slack 連携は完了しています。後続の処理を取り戻す管理ツールがこの環境にありません。運営に連絡してください。${noticeNote}`,
    recoveryAdminTool: null,
  };
}

