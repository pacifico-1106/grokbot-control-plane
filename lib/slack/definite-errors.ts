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
 *
 * `ratelimited` is deliberately NOT listed (木村 1, 2026-10-04): it stays
 * uncertain and the scheduled reconcile re-checks it on the next cron.
 */
export type SlackFixKind =
  | "slack_channel"
  | "slack_channel_membership"
  | "slack_channel_archived"
  | "slack_bot_token"
  | "slack_token_type"
  | "slack_scope"
  | "slack_permission";
/** Admin MCP tools (/api/mcp/admin) the agent runs next; both exist in ADMIN_MCP_TOOL_NAMES. */
export type SlackSetupTool = "setup.slackAdapter.setBotToken" | "setup.slackStatus";

/**
 * 木村 5 (2026-10-04): one table — each definite error, what has to be fixed
 * and which admin tool the agent runs next. The definite list below is derived
 * from it, so the two can never drift.
 *   setup.slackAdapter.setBotToken — the stored conversation token is rejected
 *     (re-register a valid xoxb Bot token; always_human approval)
 *   setup.slackStatus — diagnose first (files:write probe, channel membership,
 *     Path B readiness; nextStepJa gives the canonical order)
 */
export const SLACK_DEFINITE_ERROR_FIXES = {
  // destination
  channel_not_found: { kind: "slack_channel", nextTool: "setup.slackStatus" },
  not_in_channel: { kind: "slack_channel_membership", nextTool: "setup.slackStatus" },
  is_archived: { kind: "slack_channel_archived", nextTool: "setup.slackStatus" },
  // credential
  invalid_auth: { kind: "slack_bot_token", nextTool: "setup.slackAdapter.setBotToken" },
  not_authed: { kind: "slack_bot_token", nextTool: "setup.slackAdapter.setBotToken" },
  account_inactive: { kind: "slack_bot_token", nextTool: "setup.slackAdapter.setBotToken" },
  token_revoked: { kind: "slack_bot_token", nextTool: "setup.slackAdapter.setBotToken" },
  token_expired: { kind: "slack_bot_token", nextTool: "setup.slackAdapter.setBotToken" },
  not_allowed_token_type: { kind: "slack_token_type", nextTool: "setup.slackAdapter.setBotToken" },
  // permission
  missing_scope: { kind: "slack_scope", nextTool: "setup.slackStatus" },
  no_permission: { kind: "slack_permission", nextTool: "setup.slackStatus" },
} as const satisfies Record<string, { kind: SlackFixKind; nextTool: SlackSetupTool }>;
export type SlackDefiniteError = keyof typeof SLACK_DEFINITE_ERROR_FIXES;

export const SLACK_DEFINITE_PRE_SHARE_ERRORS: ReadonlySet<string> = new Set(Object.keys(SLACK_DEFINITE_ERROR_FIXES));

export function isDefinitePreShareSlackError(error: string | null | undefined): error is SlackDefiniteError {
  return typeof error === "string" && SLACK_DEFINITE_PRE_SHARE_ERRORS.has(error);
}

/**
 * Machine-readable reason next to pollHint=reinvoke_with_approvalId: fix it
 * with nextTool (admin MCP), then re-invoke with the approvalId. Built only
 * from the table above and sanitized scope names — never a token / secret.
 */
export type SlackReinvokeReason = {
  code: SlackDefiniteError;
  fix: { kind: SlackFixKind; needed?: string[] };
  nextTool: SlackSetupTool;
  nextToolEndpoint: "/api/mcp/admin";
  retryAfterFix: true;
};

/** STUB (test commit): the token type that failed (木村 #255 second round). */
export type SlackTokenType = "user" | "bot";

export function slackReinvokeReason(
  error: string | null | undefined,
  needed?: readonly string[],
  _tokenType?: SlackTokenType | null
): SlackReinvokeReason | null {
  if (!isDefinitePreShareSlackError(error)) return null;
  const { kind, nextTool } = SLACK_DEFINITE_ERROR_FIXES[error];
  const scopes = error === "missing_scope" ? sanitizeSlackScopes(needed) : undefined;
  return {
    code: error,
    fix: { kind, ...(scopes ? { needed: scopes } : {}) },
    nextTool,
    nextToolEndpoint: "/api/mcp/admin",
    retryAfterFix: true,
  };
}

/** Slack OAuth scope names, e.g. files:write, chat:write.public (lower case, ≤ 64 chars). */
const SLACK_SCOPE = /^[a-z][a-z0-9._-]{0,40}(:[a-z0-9._-]{1,40}){0,2}$/;
const MAX_SCOPES = 10;

/**
 * Slack's `needed` (comma-separated string) or a stored list → clean scope
 * names only. Anything token-like (xox…), mixed case, spaced or over-long is
 * dropped. undefined when nothing is left.
 */
export function sanitizeSlackScopes(value: unknown): string[] | undefined {
  const parts = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const scope = part.trim();
    if (scope.length > 64 || !SLACK_SCOPE.test(scope) || scope.startsWith("xox") || out.includes(scope)) continue;
    out.push(scope);
    if (out.length >= MAX_SCOPES) break;
  }
  return out.length ? out : undefined;
}
