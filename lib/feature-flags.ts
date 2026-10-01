/**
 * Feature flags for security hardening.
 * All flags default OFF to preserve existing production behavior.
 * Enable via environment variables after rollout verification.
 */

function parseFlag(envVar: string | undefined): boolean {
  const v = (envVar ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/**
 * PR-1 Item 1: Admin-class approvals require explicit account-approver policy.
 *
 * When ON:
 * - Admin-class tickets (isAdminClassApproval / auditClass admin / purpose admin.* / always_human admin tools)
 *   require an org-level policy with a matching admin-class route.
 * - If absent, fail closed (ticket rejected or blocked with reason code "admin_policy_required").
 * - Employee overrides cannot satisfy or replace the admin route requirement.
 * - Business-route voters cannot vote on admin-class tickets.
 *
 * When OFF (default):
 * - Existing W1 behavior preserved (any single approver).
 */
export function isAdminApproverPolicyRequired(): boolean {
  return parseFlag(process.env.ADMIN_APPROVER_POLICY_REQUIRED);
}

/**
 * PR-2 Item 5: Slack approval path hardening.
 *
 * When ON:
 * - Slack button presses require either non-empty allowedUserIds on the channel
 *   OR a valid approval_workflow_voter_bindings row for the presser.
 * - Verify team_id at press time: reject external-org users.
 * - Record decision_id in W1 for replay protection.
 *
 * When OFF (default):
 * - Existing Slack approval behavior preserved.
 */
export function isSlackApprovalStrict(): boolean {
  return parseFlag(process.env.SLACK_APPROVAL_STRICT);
}

/**
 * Google Calendar free/busy read integration.
 *
 * When ON:
 * - OAuth start/callback routes are enabled for Google Calendar.
 * - calendar.read tool queries Google freebusy.query API for allowlisted calendars.
 * - calendar.propose integrates busy intervals from Google.
 * - Connect Google Calendar step shown in employee setup flow.
 *
 * When OFF (default):
 * - Google OAuth routes return 404/disabled.
 * - calendar.read/propose behave as today (stubs or agent-supplied data only).
 * - No changes to production behavior.
 *
 * Rollout: full security audit required before enabling in production.
 * Scopes: openid email calendar.freebusy (read-only, minimal).
 */
export function isGoogleCalendarReadEnabled(): boolean {
  return parseFlag(process.env.GOOGLE_CALENDAR_READ_ENABLED);
}

/**
 * Slack reaction stamps for AI employee wakes and replies.
 *
 * When ON:
 * - Adds :eyes: reaction on triggering message when wake is accepted.
 * - Replaces/adds :white_check_mark: reaction when reply is posted.
 * - Adds :hourglass_flowing_sand: reaction when escalated to approval.
 * - Uses the posting identity already configured for the workspace.
 * - Required scope: reactions:write. Degrades silently if scope missing (logs once).
 * - No reactions in channels where bot is not a member.
 * - No reactions on Slack Connect external messages if posting is disallowed there.
 * - Idempotent: safe to call multiple times for same message.
 *
 * When OFF (default):
 * - No reaction stamps added. Existing behavior preserved.
 */
export function isSlackReactionStampsEnabled(): boolean {
  return parseFlag(process.env.SLACK_REACTION_STAMPS);
}

/**
 * P0-ID: Employee identity management tools.
 *
 * When ON:
 * - employeeIdentity.status (read-only) returns identity binding info per org.
 * - employeeIdentity.upsert and employeeIdentity.bindMailbox (always_human, admin class)
 *   allow binding employee identity to org members and mailboxes.
 * - Identity bindings are per-org with validation and audit logging.
 * - RLS enforced on employee_identity_bindings table.
 *
 * When OFF (default):
 * - employeeIdentity.* tools return feature_disabled error.
 * - No changes to existing behavior.
 */
export function isEmployeeIdentityEnabled(): boolean {
  return parseFlag(process.env.P0_EMPLOYEE_IDENTITY_ENABLED);
}

/**
 * P0-IN: Inbox routing for AI employee inbound requests.
 *
 * When ON:
 * - AI employee's approval-needed items surface to responsible human via Slack DM.
 * - Uses voter bindings to route to bound business approvers.
 * - Slack Connect shared channels are never used for approval delivery.
 * - LINE adapter seam is present but not enabled until P1.
 *
 * When OFF (default):
 * - Approvals route to default org inbox (existing behavior).
 * - No direct DM delivery to approvers.
 */
export function isInboxRoutingEnabled(): boolean {
  return parseFlag(process.env.P0_INBOX_ROUTING_ENABLED);
}

/**
 * P0-RP: Enhanced reply policy with recipient validation.
 *
 * When ON:
 * - Reply recipients must be validated against employee's allowed audience.
 * - Channel/thread/DM choice is policy-driven.
 * - Fail-closed when destination is unclear (no silent external send).
 * - reply/send approval class = business (not admin).
 *
 * When OFF (default):
 * - Existing reply policy behavior preserved.
 * - No recipient validation enforcement.
 */
export function isReplyPolicyEnhancedEnabled(): boolean {
  return parseFlag(process.env.P0_REPLY_POLICY_ENHANCED);
}

/**
 * LP_CHAT_ENABLED: Enable AI consultation chat on LP.
 *
 * When ON:
 * - Chat launcher component rendered on LP.
 * - /api/journeys, /api/chat/turn endpoints active.
 * - KB search available.
 * - Requires OPENAI_API_KEY to be configured.
 *
 * When OFF (default):
 * - No chat launcher.
 * - Consultation form only.
 */
export function isLpChatEnabled(): boolean {
  return parseFlag(process.env.LP_CHAT_ENABLED);
}

/**
 * LP_INQUIRY_DB_ENABLED: Store LP inquiries in Supabase.
 *
 * When ON:
 * - lp_inquiries table receives inserts.
 * - notification_outbox populated.
 *
 * When OFF (default):
 * - Inquiry endpoint returns success but does not persist.
 */
export function isLpInquiryDbEnabled(): boolean {
  return parseFlag(process.env.LP_INQUIRY_DB_ENABLED);
}

/**
 * LP_INQUIRY_BOT_PROTECTION_ENABLED: Turnstile verification for LP forms.
 *
 * When ON:
 * - Require cf-turnstile-response token validation.
 * - Reject bots before any DB writes.
 *
 * When OFF (default):
 * - No bot verification (existing behavior).
 */
export function isLpInquiryBotProtectionEnabled(): boolean {
  return parseFlag(process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED);
}

/**
 * LP_INQUIRY_RATE_LIMIT_ENABLED: IP-hash rate limiting for LP forms.
 *
 * When ON:
 * - Rate limit by hashed IP address.
 * - Returns 429 when exceeded.
 *
 * When OFF (default):
 * - No rate limiting.
 */
export function isLpInquiryRateLimitEnabled(): boolean {
  return parseFlag(process.env.LP_INQUIRY_RATE_LIMIT_ENABLED);
}

/**
 * LP_CATALOG_DB_ENABLED: Read catalog from Supabase instead of hardcoded.
 *
 * When ON:
 * - lp_catalog_plans table used.
 * - Falls back to hardcoded if table empty.
 *
 * When OFF (default):
 * - Hardcoded catalog only.
 */
export function isLpCatalogDbEnabled(): boolean {
  return parseFlag(process.env.LP_CATALOG_DB_ENABLED);
}

/**
 * LP_ORDER_LEDGER_ENABLED: Track orders in lp_orders table.
 *
 * When ON:
 * - checkout_attempts and lp_orders populated.
 * - Stripe webhook updates order status.
 *
 * When OFF (default):
 * - No order tracking.
 */
export function isLpOrderLedgerEnabled(): boolean {
  return parseFlag(process.env.LP_ORDER_LEDGER_ENABLED);
}

/**
 * LP_JOURNEYS_ENABLED: Enable guest journey tracking.
 *
 * When ON:
 * - /api/journeys creates journey records.
 * - Guest cookies set for session tracking.
 *
 * When OFF (default):
 * - Journey endpoint returns feature_disabled.
 */
export function isLpJourneysEnabled(): boolean {
  return parseFlag(process.env.LP_JOURNEYS_ENABLED);
}

/**
 * LP_CHAT_TOOLS_ENABLED: Enable OpenAI tool calling in chat.
 *
 * When ON:
 * - Chat turn uses function calling with KB search, catalog, etc.
 * - Tools execute against live data.
 *
 * When OFF (default):
 * - Simple completion without tools.
 */
export function isLpChatToolsEnabled(): boolean {
  return parseFlag(process.env.LP_CHAT_TOOLS_ENABLED);
}
