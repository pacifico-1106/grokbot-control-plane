/**
 * Slack Web API errors that are known to be answered BEFORE anything is
 * shared (2026-10-04, #253 follow-up 3). Single source of truth: the approved
 * re-run (lib/approvals/approved-rerun-attachment.ts) uses it to record an
 * attachment upload as "failed" (a later re-run may upload once) instead of
 * "uncertain".
 *
 * Only exact Slack `error` codes from an `ok:false` JSON answer count. Timeouts,
 * network errors, 5xx / non-JSON answers and any code not listed here stay
 * "uncertain": the share may have happened.
 *
 * Refs: https://api.slack.com/methods/files.completeUploadExternal ("Errors")
 *       and the common auth errors listed on every method page.
 */
export const SLACK_DEFINITE_PRE_SHARE_ERRORS: ReadonlySet<string> = new Set([
  // destination
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  // credential
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  // permission
  "missing_scope",
  "no_permission",
]);

export function isDefinitePreShareSlackError(error: string | null | undefined): boolean {
  return typeof error === "string" && SLACK_DEFINITE_PRE_SHARE_ERRORS.has(error);
}

// ---- stubs (木村 5, failing first) ----
export const SLACK_DEFINITE_ERROR_FIXES: Readonly<Record<string, { kind: string; nextTool: string }>> = {};
export function slackReinvokeReason(_error: string | null | undefined, _needed?: readonly string[]): Record<string, unknown> | null {
  return null;
}
export function sanitizeSlackScopes(_value: unknown): string[] | undefined {
  return undefined;
}
