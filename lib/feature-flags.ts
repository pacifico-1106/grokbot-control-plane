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
 * P1: Approval Kind Routes — per-kind approval routing.
 *
 * When ON:
 * - Approvals are routed by kind (post/mail/account/decision/other).
 * - Tool→kind mapping determines the kind.
 * - Per-kind routes with approvers, quorum, finalGo, deadline, reminders.
 * - account kind requires owner/admin human approvers only.
 *
 * When OFF (default):
 * - Existing routes[] (class=admin|business) behavior preserved.
 * - Default is owner 1名 for all kinds.
 */
export function isApprovalKindRoutesEnabled(): boolean {
  return parseFlag(process.env.P1_APPROVAL_KIND_ROUTES_ENABLED);
}

/**
 * P1: Decision Workflow — 3-tier decision system.
 *
 * When ON:
 * - decision.request tool available on Employee MCP.
 * - T1 (専決), T2 (理事過半数), T3 (社員総会) tiers.
 * - Tax-excluded amount ≥ 500,000 JPY auto-escalates to T2+.
 * - Classification-based auto-escalation (定款/役員/決算 → T3).
 * - Deputy (deputyUserId) manual-only activation.
 * - Fiscal year starts 4/1.
 *
 * When OFF (default):
 * - decision.request returns feature_disabled error.
 * - No changes to existing behavior.
 */
export function isDecisionWorkflowEnabled(): boolean {
  return parseFlag(process.env.P1_DECISION_WORKFLOW_ENABLED);
}

/**
 * P1: Topic-Gated Posting — sensitivity-based approval for posts.
 *
 * When ON:
 * - Posts to registered main-board channels undergo sensitivity check.
 * - Non-sensitive replies can skip approval (audit-logged).
 * - Sensitive topics, attachments, URLs, amount notation require approval.
 * - Errors/timeouts count as sensitive (fail-closed).
 * - Secret-detector hits block the post entirely.
 *
 * When OFF (default):
 * - All posts require approval as today.
 * - No sensitivity-based bypassing.
 */
export function isTopicGatedPostingEnabled(): boolean {
  return parseFlag(process.env.P1_TOPIC_GATED_POSTING_ENABLED);
}

/**
 * P1: Plan Rails — per-plan MCP allowlists and approval route templates.
 *
 * When ON:
 * - Gateway tools are filtered by org.plan_key → code-defined scopes
 * - Admin MCP tools are filtered by org.plan_key → code-defined scopes
 * - New orgs from Stripe checkout get plan_key from subscription metadata
 * - Plan changes trigger scope audit and pending approval cancellation
 * - Fulfill re-checks plan at execution time
 * - Downgrades at period end (scheduled), cancellation/suspension immediate
 * - Upgrades require always_human approval before applying
 *
 * When OFF (default):
 * - Existing behavior preserved (byte-identical)
 * - All scopes available to all orgs (including plan_key = NULL)
 * - plan_key column may exist but is ignored for scope filtering
 */
export function isPlanRailsEnabled(): boolean {
  return parseFlag(process.env.P1_PLAN_RAILS_ENABLED);
}

/**
 * LP_INQUIRY_DB_ENABLED: Store LP inquiries in database.
 *
 * When ON:
 * - LP inquiry form submissions are stored in lp_inquiries table.
 * - Notifications go through notification_outbox for durability.
 * - 90-day retention with cleanup cron.
 *
 * When OFF (default):
 * - Existing email-only behavior preserved.
 * - No database storage of inquiries.
 */
export function isLpInquiryDbEnabled(): boolean {
  return parseFlag(process.env.LP_INQUIRY_DB_ENABLED);
}

/**
 * LP_INQUIRY_BOT_PROTECTION_ENABLED: Bot protection for LP forms.
 *
 * When ON:
 * - Cloudflare Turnstile verification required.
 * - Per-IP-hash and global rate limits enforced.
 * - Fail-closed for AI chat (reject if verification fails).
 * - Fail-open for plain form (log but allow if keys missing).
 *
 * When OFF (default):
 * - No Turnstile verification.
 * - No rate limiting.
 * - Existing behavior preserved.
 */
export function isLpInquiryBotProtectionEnabled(): boolean {
  return parseFlag(process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED);
}

/**
 * LP_INQUIRY_CLEANUP_ENABLED: Enable cleanup of expired LP inquiries.
 *
 * When ON:
 * - Cron job can delete inquiries past retention_until.
 *
 * When OFF (default):
 * - No automatic cleanup.
 */
export function isLpInquiryCleanupEnabled(): boolean {
  return parseFlag(process.env.LP_INQUIRY_CLEANUP_ENABLED);
}

/**
 * LP_CATALOG_DB_ENABLED: Read catalog from database.
 *
 * When ON:
 * - Checkout and pricing read from catalog_items table.
 * - Catalog versioning enabled.
 *
 * When OFF (default):
 * - Hardcoded constants used (existing behavior).
 */
export function isLpCatalogDbEnabled(): boolean {
  return parseFlag(process.env.LP_CATALOG_DB_ENABLED);
}

/**
 * LP_ORDER_LEDGER_ENABLED: Record LP orders and checkout attempts.
 *
 * When ON:
 * - Orders, order_revisions, checkout_attempts, stripe_event_inbox tables used.
 * - LP setup payments recorded from checkout.session.completed webhook.
 * - Payment status updated only after verified signature and re-fetch.
 *
 * When OFF (default):
 * - No order ledger.
 * - Existing webhook behavior unchanged.
 */
export function isLpOrderLedgerEnabled(): boolean {
  return parseFlag(process.env.LP_ORDER_LEDGER_ENABLED);
}

/**
 * LP_CHAT_ENABLED: Enable AI consultation chat on LP.
 *
 * When ON:
 * - Chat launcher component rendered on LP.
 * - /api/journeys, /api/chat/turn endpoints active.
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

/**
 * LP_HANDOFF_ENABLED: Enable handoff from AI chat to human consultation.
 *
 * When ON:
 * - Handoff requests can be created from chat.
 * - /api/lp/handoff endpoints active.
 * - Outbox processes handoff notifications.
 *
 * When OFF (default):
 * - Handoff endpoints return feature_disabled.
 */
export function isLpHandoffEnabled(): boolean {
  return parseFlag(process.env.LP_HANDOFF_ENABLED);
}

/**
 * LP_WAKE_WEBHOOK_ENABLED: Enable external wake webhooks.
 *
 * When ON:
 * - /api/webhooks/lp-wake/[path] endpoints active.
 * - External systems can trigger journey resumption.
 *
 * When OFF (default):
 * - Wake webhook endpoints return feature_disabled.
 */
export function isLpWakeWebhookEnabled(): boolean {
  return parseFlag(process.env.LP_WAKE_WEBHOOK_ENABLED);
}

/**
 * P1: config.change_request — AI self-config changes need a human approver.
 *
 * When ON:
 * - Employee MCP exposes staffpass_config_change_request. An AI employee that is
 *   asked (Slack etc.) to change its own Instructions / policy text, or the
 *   channel ledger / channel classification, files a pending approval routed to
 *   the employee's approver inbox (responsible-human Slack DM when inbox routing
 *   is ON, else the employee/org approval channel: Slack / Telegram / LINE).
 * - Nothing is applied until a human approves; approve applies exactly the
 *   proposed change (+ audit), reject applies nothing (+ audit + polite notice).
 * - No resolvable approver → refused (fail-closed), nothing created or applied.
 * - whoami returns the approved Instructions overlay; admin MCP channels.classify
 *   tickets carry a before→after diff summary.
 * - Admin console / human dashboard edits are NOT gated by this flag.
 *
 * When OFF (default):
 * - Tool hidden from tools/list and returns feature_disabled; existing behavior unchanged.
 */
export function isConfigChangeRequestEnabled(): boolean {
  return parseFlag(process.env.P1_CONFIG_CHANGE_REQUEST_ENABLED);
}

/**
 * SLACK_IM_NO_ROUTE_AUDIT: user-token DM の im_no_route を org の監査ログに残す。
 *
 * When ON:
 * - Slack user-token 経由の message.im がルートなし（im_no_route）で起動しなかったとき、
 *   envelope.authorizations の user（is_bot=false）が linked 状態の社員に「一意に」
 *   対応する場合に限り、その社員の org に slack.im_wake_skipped を記録する。
 * - 0件・複数件・unlinked（needs_reauth / revoked）・team 不一致は記録しない（テナント分離）。
 * - metadata は reason / channel / teamId / eventType / eventId / 現在の分類 /
 *   channels.classify の推奨アクションのみ。本文・blocks・ts・発言者IDは入れない。
 * - 同じ org×team×DM は 10 分に 1 件（インスタンス内のベストエフォート抑制）。
 * - 記録の失敗は握りつぶし、DM 処理本体の結果は変えない。
 *
 * When OFF (default):
 * - 追加の DB 参照も監査書き込みもしない。既存挙動と完全に同じ。
 */
export function isSlackImNoRouteAuditEnabled(): boolean {
  return parseFlag(process.env.SLACK_IM_NO_ROUTE_AUDIT);
}

/**
 * SIGNUP_ATTEMPT_LOG_ENABLED: write public.signup_attempts (hashed IP/UA/mailbox,
 * outcome, signals) for every POST /api/auth/signup.
 *
 * When OFF (default): nothing is written.
 */
export function isSignupAttemptLogEnabled(): boolean {
  return parseFlag(process.env.SIGNUP_ATTEMPT_LOG_ENABLED);
}

/**
 * SIGNUP_RATE_LIMIT_ENABLED: DB-backed signup rate limits (per IP hash, per
 * normalized mailbox, global created/hour). Reads signup_attempts, so it is only
 * effective together with SIGNUP_ATTEMPT_LOG_ENABLED. Fails open on DB errors.
 *
 * When OFF (default): no signup rate limiting beyond Turnstile.
 */
export function isSignupRateLimitEnabled(): boolean {
  return parseFlag(process.env.SIGNUP_RATE_LIMIT_ENABLED);
}

/**
 * SIGNUP_DOMAIN_CHECK_ENABLED: reject disposable domains and invalid dotted
 * local parts; reject a normalized-mailbox duplicate (Gmail dot/+tag variants)
 * of an account created in the last 30 days.
 *
 * When OFF (default): no domain checks.
 */
export function isSignupDomainCheckEnabled(): boolean {
  return parseFlag(process.env.SIGNUP_DOMAIN_CHECK_ENABLED);
}

/**
 * Approved-attachment auto reconcile (2026-10-04, #253 follow-up).
 *
 * When ON, the W2 cron (app/api/cron/stuck-watch-w2) also:
 * - checks stale `running` and `uncertain` upload claims
 *   (metadata.attachmentUpload) against the Slack conversation with read-only
 *   Slack Web API calls (auth.test + conversations.replies) using the org's
 *   conversation token, and settles them (succeeded / failed / uncertain +
 *   one admin-agent stuck-watch item);
 * - records the not_sent marker for approvals whose approved text was posted
 *   while the approved attachment has no upload record.
 * Needs migration 20261004400000_approval_attachment_reconcile.sql.
 *
 * When OFF (default): no Slack call, no record change, no audit (unchanged).
 */
export function isApprovalAttachmentReconcileEnabled(): boolean {
  return parseFlag(process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED);
}
