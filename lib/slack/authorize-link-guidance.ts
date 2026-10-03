/**
 * SLACK_AUTHORIZE_LINK_ENABLED: shared, dependency-free texts / helpers for the
 * re-authorize link (used by lib/slack/authorize-link.ts and the read-only
 * setup.slackDmApprovalStatus diagnosis without a circular import).
 */
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import type { Employee } from "@/lib/types";

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;

/** Slack U… entries in the badge's allowedAccounts (service=slack, valid id). */
export function allowedSlackAccountIds(employee: Pick<Employee, "allowedAccounts">): string[] {
  return normalizeAllowedAccounts(employee.allowedAccounts)
    .filter((row) => row.service.toLowerCase() === "slack" && SLACK_USER_ID_RE.test(row.accountId))
    .map((row) => row.accountId);
}

/**
 * Next step when the badge has no Slack account in allowedAccounts.
 * There is NO admin MCP tool that edits allowedAccounts of an existing badge
 * (employees.issue sets them only at issue time; policy.patch does not touch
 * them). The only path today is the dashboard employee page (human).
 */
export const ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA =
  "社員証の許可アカウント（allowedAccounts）に Slack の U… を追加してください。" +
  "管理 MCP には既存の社員証の allowedAccounts を編集するツールはありません（policy.patch は allowedAccounts を変更しません）。" +
  "ダッシュボードの AI 社員ページ「ブラウザ・外部アカウント」で、人が Slack を選び社員本人の U… を入れて保存してください。" +
  "保存後に setup.slackAuthorizeLink.issue をもう一度呼んでください。";

/** Shown on the result page and DM'd to the link recipient when a link is burned. */
export const AUTHORIZE_LINK_FAILED_NOTICE_JA =
  "再認可リンクが別のアカウントで開かれた（または認可に失敗した）ため無効になりました。管理者に再発行を依頼してください。";
