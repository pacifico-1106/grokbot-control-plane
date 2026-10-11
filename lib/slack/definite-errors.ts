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
import { isApprovalAttachmentReconcileEnabled } from "@/lib/feature-flags";
import { isSlackAuthorizeLinkEnabled } from "@/lib/slack/authorize-link-flags";

export type SlackFixKind =
  | "slack_channel"
  | "slack_channel_membership"
  | "slack_channel_archived"
  | "slack_bot_token"
  | "slack_user_token"
  | "slack_token"
  | "slack_token_type"
  | "slack_scope"
  | "slack_permission";
/** Admin MCP tools (/api/mcp/admin) the agent runs next; all exist in ADMIN_MCP_TOOL_NAMES. */
export type SlackSetupTool = "setup.slackAdapter.setBotToken" | "setup.slackAuthorizeLink.issue" | "setup.slackStatus";

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
 * Which token Slack rejected (木村 #255 second round): the upload adapter
 * resolves the conversation token itself (resolveConversationToken →
 * effectivePostingAs: "user" = the employee's linked Slack user token, "bot" =
 * the org conversation Bot token), so the failure point always knows it. Kept
 * on the failed record as slackTokenType; records written before this change
 * have none (→ unknown).
 */
export type SlackTokenType = "user" | "bot";

export function isSlackTokenType(value: unknown): value is SlackTokenType {
  return value === "user" || value === "bot";
}

/**
 * Token-dependent guidance while APPROVAL_ATTACHMENT_RECONCILE_ENABLED is ON
 * (木村 #255 second + third round). Credential errors (the table's setBotToken rows):
 *   bot     → setup.slackAdapter.setBotToken (the table entry, unchanged)
 *   user    → setup.slackAuthorizeLink.issue (the employee re-authorizes) — only
 *             while SLACK_AUTHORIZE_LINK_ENABLED is ON; OFF → setup.slackStatus
 *             (never point at a tool that would answer authorize_link_flag_off)
 *   unknown → setup.slackStatus: diagnose first (read-only; a valid Bot token is
 *             never replaced on a guess)
 * not_allowed_token_type → setup.slackStatus for every token (the wrong token
 *   KIND is in use: diagnose which one before replacing anything; third round c).
 * missing_scope → user token: setup.slackAuthorizeLink.issue (re-authorizing adds
 *   the scopes; link flag OFF → setup.slackStatus); bot / unknown: setup.slackStatus.
 * fix.tokenType is set for credential errors and missing_scope.
 * Flag OFF → the table entry for every token (da97a12 behavior).
 */
const UNKNOWN_TOKEN_FIX = { kind: "slack_token", nextTool: "setup.slackStatus" } as const;

function isCredentialError(error: SlackDefiniteError): boolean {
  return SLACK_DEFINITE_ERROR_FIXES[error].nextTool === "setup.slackAdapter.setBotToken";
}

/** The authorize link when it can be used, else the read-only diagnosis. */
function userReauthorizeTool(): SlackSetupTool {
  return isSlackAuthorizeLinkEnabled() ? "setup.slackAuthorizeLink.issue" : "setup.slackStatus";
}

function tokenDependentFix(
  error: SlackDefiniteError,
  token: SlackTokenType | "unknown"
): { kind: SlackFixKind; nextTool: SlackSetupTool } {
  const entry = SLACK_DEFINITE_ERROR_FIXES[error];
  if (error === "not_allowed_token_type") return { kind: entry.kind, nextTool: "setup.slackStatus" };
  if (error === "missing_scope") return { kind: entry.kind, nextTool: token === "user" ? userReauthorizeTool() : entry.nextTool };
  if (token === "user") return { kind: "slack_user_token", nextTool: userReauthorizeTool() };
  if (token === "unknown") return { ...UNKNOWN_TOKEN_FIX };
  return entry;
}

/**
 * Machine-readable reason next to pollHint=reinvoke_with_approvalId: fix it
 * with nextTool (admin MCP), then re-invoke with the approvalId. Built only
 * from the table above and sanitized scope names — never a token / secret.
 * fix.tokenType ("user" | "bot" | "unknown") is present for credential errors
 * and missing_scope while the reconcile flag is ON.
 */
export type SlackReinvokeReason = {
  code: SlackDefiniteError;
  fix: { kind: SlackFixKind; needed?: string[]; tokenType?: SlackTokenType | "unknown" };
  nextTool: SlackSetupTool;
  nextToolEndpoint: "/api/mcp/admin";
  retryAfterFix: true;
};

export function slackReinvokeReason(
  error: string | null | undefined,
  needed?: readonly string[],
  tokenType?: SlackTokenType | null
): SlackReinvokeReason | null {
  if (!isDefinitePreShareSlackError(error)) return null;
  let { kind, nextTool }: { kind: SlackFixKind; nextTool: SlackSetupTool } = SLACK_DEFINITE_ERROR_FIXES[error];
  let token: SlackReinvokeReason["fix"]["tokenType"];
  if ((isCredentialError(error) || error === "missing_scope") && isApprovalAttachmentReconcileEnabled()) {
    token = isSlackTokenType(tokenType) ? tokenType : "unknown";
    ({ kind, nextTool } = tokenDependentFix(error, token));
  }
  const scopes = error === "missing_scope" ? sanitizeSlackScopes(needed) : undefined;
  return {
    code: error,
    fix: { kind, ...(scopes ? { needed: scopes } : {}), ...(token ? { tokenType: token } : {}) },
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
