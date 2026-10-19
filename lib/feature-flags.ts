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
 * LP_AUTO_PROVISION_MODE (design 2026-10-12 §5-10, PR3). Default off.
 *
 * "dry_run" (the only value implemented by PR3): a paid LP setup-fee Checkout
 * Session (re-fetched from Stripe by id after the verified webhook) is recorded
 * in lp_provisionings (migration 20261012400000) and 安藤 / operators are
 * notified once per Session. No tenant is created.
 * Anything else — unset, "off", and the not-yet-implemented "confirm" / "auto" —
 * is off: the webhook ignores LP setup-fee sessions exactly as before.
 */
export function lpAutoProvisionMode(): "off" | "dry_run" {
  return process.env.LP_AUTO_PROVISION_MODE === "dry_run" ? "dry_run" : "off";
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
 * LP_LEAD_PAGE_DB_ENABLED: write lp_page / lp_ref on lp_inquiries and lp_journeys.
 *
 * Turn ON only after migration 20261012300000_lp_lead_page.sql is applied.
 * When OFF (default): those columns are neither written nor required; the lead page
 * and ref still reach Stripe metadata and the notification emails.
 */
export function isLpLeadPageDbEnabled(): boolean {
  return parseFlag(process.env.LP_LEAD_PAGE_DB_ENABLED);
}

/**
 * LP_INQUIRY_RATE_LIMIT_ENABLED: IP-hash rate limiting for LP forms
 * (consult / inquiry POST and journeys chat start).
 *
 * When ON:
 * - Rate limit by HMAC(IP_HASH_KEY, IP) plus a process-global cap.
 * - Returns 429 + Retry-After (Japanese message) when exceeded.
 * - Missing IP_HASH_KEY → 503 fail-closed. Honeypot / Turnstile still run.
 *
 * When OFF (default):
 * - This flag adds no limiter. Existing bot-protection rate limits (if that
 *   flag is ON) are unchanged.
 */
export function isLpInquiryRateLimitEnabled(): boolean {
  return parseFlag(process.env.LP_INQUIRY_RATE_LIMIT_ENABLED);
}

/**
 * LP_INQUIRY_FIXED_SUBJECT_ENABLED: LP consult-form notify mail uses a
 * fixed subject (prefix + receipt id only). User-controlled strings go
 * only into escaped body fields.
 *
 * When ON:
 * - Subject is `【AI社員パック問い合わせ】{受付番号}`.
 * - Company / name / email / use-case etc. appear only in HTML-escaped
 *   table cells. Newlines and control characters are stripped; length is
 *   capped. Email and URLs are plain text (no mailto / href).
 *
 * When OFF (default):
 * - Today's subject `【AI社員パック問い合わせ】{会社} - {名前}様` and
 *   mailto link in the body are unchanged.
 */
export function isLpInquiryFixedSubjectEnabled(): boolean {
  return parseFlag(process.env.LP_INQUIRY_FIXED_SUBJECT_ENABLED);
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
 * SIGNUP_RATE_LIMIT_REQUIRED_ENABLED: make Layer 2 per-IP / per-mailbox
 * signup rate limits mandatory before welcome / trial mail.
 *
 * When ON:
 * - evaluateSignupLayer2 always applies those limits (even if
 *   SIGNUP_RATE_LIMIT_ENABLED is OFF).
 * - Missing attempt store, unreadable store, or missing IP hash → 503
 *   fail-closed. Signup does not create an account and does not send mail.
 * - Attempt rows are written even if SIGNUP_ATTEMPT_LOG_ENABLED is OFF, so
 *   the counters have somewhere to live. Insert failure → do not send mail.
 *
 * When OFF (default):
 * - Today's fail-open Layer 2 is unchanged. Mail still goes out.
 */
export function isSignupRateLimitRequiredEnabled(): boolean {
  return parseFlag(process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED);
}

/**
 * LOGIN_RATE_LIMIT_ENABLED: app-side login attempt limits (IP+account, plus a
 * per-IP spray cap). In-memory / per-instance; Supabase Auth still has its own
 * limits. Missing IP_HASH_KEY or a full bucket store fails closed (503 / deny).
 *
 * When OFF (default): POST /api/auth/login is unchanged (no extra limiter,
 * no IP_HASH_KEY requirement).
 */
export function isLoginRateLimitEnabled(): boolean {
  return parseFlag(process.env.LOGIN_RATE_LIMIT_ENABLED);
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

/**
 * MCP endpoint handoff (木村 request / 八坂 GO, 2026-10-04).
 *
 * When ON:
 * - employees.issue / link results (Admin MCP + REST) and every agent wake
 *   (Slack user-token channel / user-token IM / bot mention / internal IM and
 *   approval.resolved callback + machine email from Slack / LINE / Telegram / Web /
 *   proxy) carry a secret-free `mcpHandoff` block (endpoint from resolveAppOrigin,
 *   connection steps, staffpass_whoami connectivity check).
 * - Authenticated MCP tools/list|call record a throttled `mcp.client_seen` audit.
 * - The stuck-watch cron flags handoff wakes with no later credential activity and
 *   sends one next-step notice per employee per 24h to a human channel (no re-wake).
 *
 * When OFF (default):
 * - No payload, audit, notification or response changes (exact current behavior).
 */
export function isMcpEndpointHandoffEnabled(): boolean {
  return parseFlag(process.env.MCP_ENDPOINT_HANDOFF_ENABLED);
}

/**
 * MCP 2026-07-28 strict request headers (D1, 2026-10-05; lib/mcp/protocol-negotiation.ts).
 * /api/mcp and /api/mcp/admin always reject headers that DISAGREE with the body
 * (HTTP 400, -32020) and unsupported per-request versions (HTTP 400, -32022).
 *
 * When ON, additionally (spec MUSTs that could reject a client that works today):
 * - a modern request (body `_meta` protocolVersion 2026-07-28) without
 *   MCP-Protocol-Version / Mcp-Method / Mcp-Name (tools/call) → 400 -32020;
 *   without `_meta` clientCapabilities → 400 -32602
 * - `MCP-Protocol-Version: 2026-07-28` with no `_meta` protocolVersion → 400 -32602
 * - an unknown MCP-Protocol-Version on an initialize-era request → 400 -32022
 *
 * When OFF (default): those requests are served as before (missing headers are
 * tolerated; an unknown header version on an initialize-era request is ignored).
 */
export function isMcpStrictRequestHeadersEnabled(): boolean {
  return parseFlag(process.env.MCP_STRICT_REQUEST_HEADERS);
}

/**
 * Duplicate-reply prevention for conversation tools (comm.reply / comm.send /
 * slack.post / slack.post_external), channel-independent (Slack / LINE / Telegram).
 *
 * When ON:
 * - the same employee sending a normalized-equal (or, in similar mode, a
 *   near-equal) body to the same conversation within the window is not sent:
 *   `duplicate_reply_suppressed` + audit (hashes only, never the body)
 * - a newer reply / approval request for a conversation supersedes older pending
 *   conversation approvals; fulfill re-checks and closes stale ones as superseded
 * - pending conversation approvals expire (COMM_REPLY_APPROVAL_TTL_MINUTES)
 *
 * When OFF (default): no change. Requires migration 20261004700000.
 * DUPLICATE_GUARD_V2_ENABLED implies this (v2 is a superset of the ledger).
 * Details: docs/comm-reply-dedup.md
 */
export function isCommReplyDedupEnabled(): boolean {
  return parseFlag(process.env.COMM_REPLY_DEDUP_ENABLED) || isDuplicateGuardV2Enabled();
}

/**
 * Duplicate post guard v2 (Yasaka / 木村 2026-10-05, PR-A). Default OFF.
 * Everything here can stop a post that v1 lets through, so it is flagged:
 * - window 6 h (v1 30 min); the same jobId + same body to the same channel goes
 *   out once regardless of time (job key, kept 30 days)
 * - a top-level post and a thread post in one channel are compared
 * - another employee posting the same content to the same conversation is
 *   blocked (COMM_REPLY_DEDUP_CROSS_EMPLOYEE=warn keeps it to a warning)
 * - short bodies (< 20 normalized chars): mention / emoji / shortcode
 *   normalization, same thread only, short window (2 min)
 * - a post with an unknown outcome (timeout, 5xx, network error after submit)
 *   keeps its fingerprint; a resend needs duplicateGuard.confirmedNotDelivered
 * - every posting tool path (sns.publish, file uploads with a message) uses
 *   the same ledger; ledger errors fail closed
 * Turning it ON also turns the v1 ledger on. Requires migration 20261005300000.
 * Details: docs/comm-reply-dedup.md ("v2")
 */
export function isDuplicateGuardV2Enabled(): boolean {
  return parseFlag(process.env.DUPLICATE_GUARD_V2_ENABLED);
}

/**
 * Thread single-flight (木村 2026-10-09 A, 八坂 GO; triage #2). Default OFF.
 * For conversation posts (comm.reply / comm.send / slack.post /
 * slack.post_external — direct, caller-delivered and approval fulfil):
 * - one send per thread at a time: a short lease (TTL
 *   THREAD_SINGLE_FLIGHT_LEASE_TTL_SECONDS, default 60) → 409 thread_busy
 * - right before sending: the employee already posted in the thread after the
 *   point the AI read through (readThroughTs, else the inbound ts) →
 *   409 thread_moved_on; at fulfil the approved snapshot's read point is used
 * - lease-store errors fail closed (503 thread_guard_unavailable)
 * Requires migration 20261009100000. Details: docs/thread-single-flight.md
 */
export function isThreadSingleFlightEnabled(): boolean {
  return parseFlag(process.env.THREAD_SINGLE_FLIGHT_ENABLED);
}

/**
 * MCP Events (2026-10-05, design: docs/mcp-events-approval-wake-20261005.md).
 * Wakes the AI through MCP Events webhooks (Triggers & Events extension, as
 * implemented by ChatGPT) when one of its approvals is decided or expires.
 *
 * When ON:
 * - /api/mcp answers events/list, events/subscribe, events/unsubscribe behind
 *   the employee badge and advertises capabilities.events in initialize.
 * - The shared decision side effects (Web / Slack / LINE / Telegram / proxy)
 *   emit approval.decided; closing an approval as expired emits approval.expired.
 *   Deliveries are Standard Webhooks signed, SSRF-guarded (DNS pinned on every
 *   attempt, no redirects), ids + status only, deduped by eventId, re-checked
 *   against the badge on every attempt (revocation stops delivery at once).
 * - The approval.resolved callback payload gains the same `eventId` (dedupe).
 * - /api/cron/mcp-events-deliver retries pending deliveries (Bearer CRON_SECRET via
 *   lib/security/cron-secret.ts) and deletes finished delivery rows after 7 days.
 * - A revocation re-check that cannot run (DB read error) defers the attempt;
 *   only a positively known revocation stops subscriptions.
 * Requires migration 20261005000000_mcp_event_subscriptions.sql and
 * NOTIFICATION_CONFIG_ENCRYPTION_KEY (receiver secrets are stored encrypted).
 *
 * When OFF (default):
 * - No method, capability, payload, audit, table access or outbound request
 *   changes (exact current behavior).
 */
export function isMcpEventsEnabled(): boolean {
  return parseFlag(process.env.MCP_EVENTS_ENABLED);
}

/**
 * D9 (八坂 GO 2026-10-05): hardened delivery for the two pre-existing outbound
 * webhooks — the approval.resolved callback (employee.callbackUrl) and the
 * conversation wake webhook (binding.wakeWebhookUrl).
 *
 * When ON:
 * - Both go through #267's postWebhook (lib/mcp-events/transport.ts): https on
 *   443 only, hostname (no IP literal / internal names), EVERY DNS answer must
 *   be public, the checked address is pinned for the connection, redirects are
 *   never followed, 256 KiB body cap, overall timeout with socket teardown.
 * - Standard Webhooks headers (webhook-id / -timestamp / -signature). Callback
 *   key: the employee's minted callback secret (employee_webhook_settings) →
 *   else the existing wake-webhook secret → else unsigned. Wake key: the
 *   existing wake-webhook secret (the Bearer header is still sent).
 * - The callback body is minimal (ids + status) unless the employee's config
 *   opts into callback_payload = legacy_full (today's body).
 * - webhook-id for the callback = the MCP Events eventId when there is one (D7).
 * Requires migration 20261005100000_employee_webhook_settings.sql (settings
 * that cannot be read → the callback is not sent, category config_unavailable).
 * The signing secret is read strictly: a read error or an undecryptable secret
 * (callback secret or the wake-secret fallback, and the wake webhook's own
 * secret) → not sent, config_unavailable, audited — never silently unsigned.
 * Only a genuinely absent secret means unsigned.
 * The legacy_full setting can be stored while OFF (no delivery effect).
 *
 * When OFF (default): receivers get exactly today's requests (fetch, same
 * headers and body). Independent of the flag, the approver-facing result and
 * audit rows carry only a failure category (never raw error text, the
 * receiver's status or body).
 */
export function isWebhookHardeningEnabled(): boolean {
  return parseFlag(process.env.WEBHOOK_HARDENING_ENABLED);
}

/**
 * APPROVER_AUTHORITY_ENABLED (PR-D): who may approve changes to approvers and
 * permissions (lib/approver-authority).
 *
 * When ON:
 * - Filing records approval_requests.required_approver_kind for the targets in
 *   APPROVER_AUTHORITY_TARGETS: "owner_or_designated_admin" (standard) or
 *   "owner" (sensitive, decided from the content of the change).
 * - Approving such a ticket (W1 RPC resolve_approval_w1_checked with
 *   p_enforce_approver_authority, or the F8 vote path) requires a verified
 *   member who is an active owner, or an active admin listed in
 *   orgs.designated_admin_member_ids. A designated admin on an owner ticket is
 *   recorded as an endorsement and the ticket stays オーナー承認待ち. The
 *   approver's member id + role are stored on the ticket.
 * - Fulfil re-verifies the stored approver right before execution.
 * - Zero active owners, an unverifiable approver or an unreadable setting → stop.
 * - approvers.designatedAdmins.get / .set (admin MCP) are available.
 * Requires migration 20261005500000_approver_authority.sql (without it, filing
 * a target ticket fails instead of silently dropping the requirement).
 *
 * When OFF (default): behaviour is unchanged (nothing recorded, nothing checked).
 */
export function isApproverAuthorityEnabled(): boolean {
  return parseFlag(process.env.APPROVER_AUTHORITY_ENABLED);
}

/**
 * OWNER_PROMOTION_ENABLED: admin MCP members.promoteOwner (make an existing
 * active member an owner after ONE existing owner approves; not the requester,
 * not the target). Also requires APPROVER_AUTHORITY_ENABLED — without PR-D's
 * approver check the ticket could be approved by a non-owner, so the tool
 * refuses at filing AND at fulfil unless both are ON. Default OFF.
 * No removal / transfer of ownership.
 */
export function isOwnerPromotionEnabled(): boolean {
  return parseFlag(process.env.OWNER_PROMOTION_ENABLED) && isApproverAuthorityEnabled();
}

/**
 * 木村 2026-10-09 B (triage #3): needs_approval answers carry approvalReasons[]
 * (every reason, structured), tickets store the same list, every approval card
 * shows one 「承認が必要な理由」 line, and the employee MCP lists the tenant's
 * sensitive topics read-only (staffpass_sensitive_topics). Default OFF.
 */
export function isApprovalReasonsEnabled(): boolean {
  return parseFlag(process.env.APPROVAL_REASONS_ENABLED);
}

/**
 * APPROVAL_MAIL_SUBJECT_NO_SUMMARY_ENABLED: approval notify mail subject
 * is fixed text + kind + short id. AI / requester summary stays in the
 * escaped body only.
 *
 * When ON:
 * - Needed: `[Staffpass] 承認リクエスト {kind} {id}`
 * - Resolved: `[Staffpass] 承認結果 {kind} {id}`
 * - kind / id are sanitized (no control chars). Missing meta → ticket / unknown.
 *
 * When OFF (default):
 * - Needed subject remains `[要対応] AI社員の承認リクエスト（{risk}）`.
 * - Resolved subject remains `[AI社員] 承認が解決されました（{結果}）`.
 */
export function isApprovalMailSubjectNoSummaryEnabled(): boolean {
  return parseFlag(process.env.APPROVAL_MAIL_SUBJECT_NO_SUMMARY_ENABLED);
}

/**
 * 木村 2026-10-09 B (triage #1④): comm.send with no explicit class defaults to
 * internal + summary only when the destination is internal in the credential
 * org's channel ledger (internal channel / internal DM route) and the resolved
 * audience is internal. Default OFF (changes a default → new flag).
 */
export function isCommSendInternalDefaultEnabled(): boolean {
  return parseFlag(process.env.COMM_SEND_INTERNAL_DEFAULT_ENABLED);
}

/**
 * MCP OAuth 2.1 Authorization Server + Resource Server (design 2026-10-03).
 *
 * When ON (and not DEMO mode):
 * - /.well-known/oauth-protected-resource[/api/mcp] and
 *   /.well-known/oauth-authorization-server answer JSON.
 * - /oauth/authorize, /oauth/consent, /api/oauth/{consent,token,revoke} are live.
 * - /api/mcp accepts sp_at_ access tokens (bound to one AI employee by a tenant admin)
 *   next to the unchanged gb_emp_ Bearer path; 401s carry WWW-Authenticate.
 *
 * When OFF (default): all of the above 404 / rejected; /api/mcp exactly as today.
 */
export function isMcpOAuthFlagOn(): boolean {
  return parseFlag(process.env.MCP_OAUTH_ENABLED);
}

/** Dynamic Client Registration (RFC 7591; deprecated in MCP 2026-07-28). Default OFF. Needs MCP_OAUTH_ENABLED too. */
export function isMcpOAuthDcrFlagOn(): boolean {
  return parseFlag(process.env.MCP_OAUTH_DCR_ENABLED);
}

/**
 * MCP_EMPLOYEE_BADGE_MCP_ENABLED (default OFF).
 *
 * When ON:
 * - /api/mcp/employee is a badge-only mouth (404 while OFF). It never
 *   advertises OAuth (no WWW-Authenticate resource_metadata, no server-card
 *   auth.oauth, no OAuth initialize sentence). sp_at_ is refused.
 * - On /api/mcp, a request that looks like a static-badge attempt (Authorization
 *   present — including empty / unexpanded `${env:…}` — or
 *   x-staffpass-credential) does not get an OAuth challenge. Unauthenticated
 *   requests (no header) still get resource_metadata so Claude / ChatGPT
 *   discovery is unchanged. 401 JSON-RPC errors on a badge attempt include
 *   one Japanese nextStepJa that does not say whether a secret exists.
 *
 * When OFF (default): /api/mcp/employee is 404; /api/mcp is byte-identical
 * to today (empty Bearer still gets the OAuth challenge when OAuth is ON).
 */
export function isEmployeeBadgeMcpEnabled(): boolean {
  return parseFlag(process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED);
}

/**
 * WHOAMI_CREDENTIAL_INFO_ENABLED (default OFF).
 *
 * When ON, staffpass_whoami adds:
 * - credential.kind (gb_emp | oauth) and credential.expiresAt (ISO, or null
 *   when the 社員証 has no expiry). OAuth uses the 社員証 expiry, never the
 *   access-token TTL.
 * - org.name for the caller's tenant only.
 * - expiringSoon + nextStepJa when that expiry is within 7 days (or already
 *   expired, if a race lets the call through; auth itself is 401).
 *
 * Never includes credential id, secret, prefix, hash, or another employee/org.
 * /api/mcp and /api/mcp/employee share the same payload builder.
 *
 * When OFF (default): whoami JSON is byte-identical to today.
 */
export function isWhoamiCredentialInfoEnabled(): boolean {
  return parseFlag(process.env.WHOAMI_CREDENTIAL_INFO_ENABLED);
}

/**
 * MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE (Q4 escape hatch, 木村 2026-10-10).
 * Only matters when MCP_OAUTH_ENABLED is ON. Unset / empty / anything that is
 * not an explicit false → TODAY's behaviour: unauthenticated initialize / ping /
 * server/discover / notifications stay 200/202. Only an explicit
 * "false" / "0" / "off" / "disabled" / "no" switches them to 401 +
 * WWW-Authenticate (what Claude needs to start sign-in). Unlike the other
 * flags this one is "on" when unset, so that turning OAuth on can never by
 * itself change what unauthenticated initialize returns.
 */
export function isMcpOAuthLegacyUnauthInitialize(): boolean {
  const v = (process.env.MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "disabled" || v === "no");
}

/** Q2 hook: require MFA (aal2) for OAuth consent. Default OFF (no MFA yet). */
export function isMcpOAuthConsentMfaRequired(): boolean {
  return parseFlag(process.env.MCP_OAUTH_CONSENT_REQUIRE_MFA);
}

/**
 * CREDENTIAL_EXPIRY_NOTICE_ENABLED (木村 2026-10-12): 社員証 pre-expiry notice
 * (7 days before + the day before) to the tenant's approval inbox, from the
 * daily digest cron. IDs + dashboard link only; dedup per credential ×
 * threshold (credential_expiry_notices, migration 20261012100000); per-org
 * caps. Default OFF: nothing is read, written or sent.
 */
export function isCredentialExpiryNoticeEnabled(): boolean {
  return parseFlag(process.env.CREDENTIAL_EXPIRY_NOTICE_ENABLED);
}

/**
 * ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED (木村 2026-10-12): admin MCP
 * employees.credential.reissue. always_human ticket; after approval the new
 * 社員証 is minted only at the dashboard hand-over (rotate with
 * reissueApprovalId, one-time display to a credential admin) — never returned
 * to the AI. Default OFF: the tool answers feature_disabled and the rotate
 * route refuses reissueApprovalId.
 */
export function isAdminMcpCredentialReissueEnabled(): boolean {
  return parseFlag(process.env.ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED);
}

/**
 * MAIL_SEND_GMAIL_LIVE (default OFF): approved mail.send may call Gmail
 * users.messages.send after the attachment hash check.
 *
 * When OFF (default): fulfillMailSend stays delivery:"stub" (nothing leaves).
 * Calendar OAuth / freebusy is unchanged.
 *
 * When ON: employee must have completed the separate gmail.send consent
 * (incremental, not mixed into the calendar start URL). From must equal the
 * authenticated mailbox. Unknown provider outcomes are recorded and not retried.
 * draft_only / external-send defaults are not loosened.
 */
export function isMailSendGmailLiveEnabled(): boolean {
  return parseFlag(process.env.MAIL_SEND_GMAIL_LIVE);
}

/**
 * MAIL_UNVERIFIED_FROM_ENABLED (default OFF): unverified-recipient
 * transactional mail (signup welcome / trial_started) may use
 * EMAIL_FROM_UNVERIFIED so a third-party replay does not inherit the
 * production From / DKIM identity.
 *
 * When OFF (default): every Resend path keeps EMAIL_FROM (today).
 * When ON: unverified audience requires EMAIL_FROM_UNVERIFIED; if it is
 * missing or blank, send is refused (fail-closed, no fallback to EMAIL_FROM).
 * Verified notices (approval / billing / ops) always stay on EMAIL_FROM.
 */
export function isMailUnverifiedFromEnabled(): boolean {
  return parseFlag(process.env.MAIL_UNVERIFIED_FROM_ENABLED);
}

/**
 * WELCOME_MAIL_FIXED_SUBJECT_ENABLED (default OFF): signup welcome /
 * trial_started / trial_ending mail subjects are fixed Staffpass copy.
 * orgName (signup-chosen) and other user-controlled strings stay in the
 * escaped body only.
 *
 * When ON:
 * - Welcome: `ようこそ — Staffpass（AIエージェントの社員証）`
 * - Trial started: `トライアル開始 — Staffpass（AIエージェントの社員証）`
 * - Trial ending: `トライアル終了のお知らせ — Staffpass（AIエージェントの社員証）`
 * - Body orgName is HTML-escaped, control/bidi/zero-width stripped
 *   (same range as LP inquiry #403), length-capped, and not linkified.
 *
 * When OFF (default):
 * - Today's subjects (`ようこそ — ${orgName} の AI社員 制御面`,
 *   `トライアル開始（${trialDays}日間）`,
 *   `トライアル終了まであと ${daysLeft} 日 — ${orgName}`).
 */
export function isWelcomeMailFixedSubjectEnabled(): boolean {
  return parseFlag(process.env.WELCOME_MAIL_FIXED_SUBJECT_ENABLED);
}

/**
 * MCP_AUTH_FAILURE_AUDIT_ENABLED (default OFF): write /api/mcp 401/403
 * auth-failure kinds (missing_credential / invalid / expired) to
 * mcp_auth_failures (migration 20261016400000). Ids when resolvable; never
 * the token or its hash. Throttled in SQL. Flag OFF: no read, no write.
 */
export function isMcpAuthFailureAuditEnabled(): boolean {
  return parseFlag(process.env.MCP_AUTH_FAILURE_AUDIT_ENABLED);
}

/**
 * MCP_AUTH_401_NEXT_STEP_JA_ENABLED (default OFF): add Japanese nextStepJa
 * on /api/mcp 401 bodies for missing/empty vs expired vs invalid. Machine-
 * readable data.code is unchanged. Flag OFF: 401 body identical to today.
 */
export function isMcpAuth401NextStepJaEnabled(): boolean {
  return parseFlag(process.env.MCP_AUTH_401_NEXT_STEP_JA_ENABLED);
}

/**
 * AI_PEER_WAKE_ALLOWLIST_ENABLED (八坂 GO 2026-10-16): when the speaker is a
 * bound AI employee, other AI employees are woken only if the org allowlisted
 * that pair (A→B, optional channel). Fail-closed: missing/unreadable pair or
 * a lookup error does not wake. Human mentions are unchanged.
 *
 * When OFF (default): existing mention/DM/Path C wake behavior is preserved.
 */
export function isAiPeerWakeAllowlistEnabled(): boolean {
  return parseFlag(process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED);
}

/**
 * AI_PEER_WAKE_THREAD_GUARD_ENABLED (八坂 GO 2026-10-16): AI→AI wakes in the
 * same Slack thread (thread_ts, or channel + time window for a root message)
 * are capped (default 4) and a human can stop the thread. Cap cutoff is
 * audited and the org's approvers are notified. Stop is human-only (Slack
 * button + dashboard); AI cannot stop or resume. Human mentions still wake.
 *
 * When OFF (default): no cap, no stop, no notice. Independent of the allowlist
 * flag so rollout can enable cap-first or allowlist-first.
 */
export function isAiPeerWakeThreadGuardEnabled(): boolean {
  return parseFlag(process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED);
}

/**
 * EMPLOYEE_RETIRE_ENABLED (default OFF): admin MCP employees.retire may file
 * an always_human ticket. Execution stays on the dashboard (人間のみ).
 * checkOperable の status=suspended 拒否はフラグに依存しない（hold と同じ）。
 */
export function isEmployeeRetireEnabled(): boolean {
  return parseFlag(process.env.EMPLOYEE_RETIRE_ENABLED);
}

/**
 * PASSWORD_RESET_TURNSTILE_ENABLED (default OFF): require Cloudflare Turnstile
 * on POST /api/auth/forgot-password before resetPasswordForEmail.
 *
 * When ON:
 * - CAPTCHA runs after the email-format check and before send quotas.
 * - Missing token, failed siteverify, missing keys, missing/wrong action, or
 *   a hostname outside PASSWORD_RESET_TURNSTILE_HOSTNAMES (default
 *   staffpass.sealith.com) → do not call Supabase. CAPTCHA error only.
 * - CAPTCHA failures use a separate IP brake and never return sent=1.
 * - The /auth/forgot widget is shown only when this flag is ON and a site key
 *   is present.
 *
 * When OFF (default): today's recover path is unchanged (same-origin +
 * in-process rate limits only; no CAPTCHA).
 */
export function isPasswordResetTurnstileEnabled(): boolean {
  return parseFlag(process.env.PASSWORD_RESET_TURNSTILE_ENABLED);
}

/**
 * SUPABASE_AUTH_CAPTCHA_ENABLED (default OFF): pass an unused Turnstile token
 * to GoTrue as captchaToken on password sign-in and resetPasswordForEmail.
 *
 * When ON:
 * - POST /api/auth/login requires a token and forwards options.captchaToken.
 *   We do not siteverify it (single-use; Supabase redeems it).
 * - POST /api/auth/signup still siteverifies the existing signup widget, and
 *   requires a second unused token for the post-create signInWithPassword.
 * - POST /api/auth/forgot-password forwards captchaToken. If
 *   PASSWORD_RESET_TURNSTILE_ENABLED is also ON, that local siteverify keeps
 *   using a different token; the same token is never reused.
 *
 * When OFF (default): Auth payloads match main (no captchaToken key). Local
 * Turnstile behavior is unchanged.
 *
 * Rollout: enable this flag first so login keeps working, then turn on
 * CAPTCHA in the Supabase Dashboard. Reversing that order rejects sign-in
 * until captchaToken is sent.
 */
export function isSupabaseAuthCaptchaEnabled(): boolean {
  return parseFlag(process.env.SUPABASE_AUTH_CAPTCHA_ENABLED);
}

const DEFAULT_AI_PEER_WAKE_CAP = 4;
const DEFAULT_AI_PEER_WAKE_ROOT_WINDOW_SECONDS = 30 * 60;

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Default 4; clamp 1..20. Used only when AI_PEER_WAKE_THREAD_GUARD_ENABLED is ON. */
export function aiPeerWakeCap(): number {
  return parseBoundedInt(process.env.AI_PEER_WAKE_CAP, DEFAULT_AI_PEER_WAKE_CAP, 1, 20);
}

/** Root-message window when thread_ts is absent. Default 1800s; clamp 60..86400. */
export function aiPeerWakeRootWindowSeconds(): number {
  return parseBoundedInt(
    process.env.AI_PEER_WAKE_ROOT_WINDOW_SECONDS,
    DEFAULT_AI_PEER_WAKE_ROOT_WINDOW_SECONDS,
    60,
    86_400
  );
}

/**
 * ORG_NAME_INPUT_STRICT_ENABLED (default OFF): strict org name validation at
 * signup and orgs.create input time.
 *
 * When ON:
 * - Reject bidi control characters (U+202A–202E, U+2066–2069, U+200E/F, U+061C)
 * - Reject zero-width and invisible characters (U+200B–200D, U+2060, U+FEFF,
 *   U+00AD, U+180E)
 * - Reject control characters and CR/LF
 * - Reject URL-like strings (http/https/javascript/data/vbscript/file/mailto
 *   schemes, www. prefix, domain-like tokens like example.com or evil.co.jp/x)
 * - Error messages do not echo the input value.
 *
 * False positive avoidance:
 * - Japanese company names (株式会社スペースツリー, 一般社団法人みらい社中)
 * - English company names with periods (TOKYO307 Inc., A&B Co., Ltd.)
 * - Full-width space (正規化後に通常スペースになる)
 * - Regular periods in names (T.K. Holdings)
 * - Domain detection is limited to alphanumeric labels + TLD (2+ letters)
 *
 * When OFF (default):
 * - Existing validation behavior preserved.
 * - Base validation (empty, length, demo placeholder) still applies.
 */
export function isOrgNameInputStrictEnabled(): boolean {
  return parseFlag(process.env.ORG_NAME_INPUT_STRICT_ENABLED);
}
