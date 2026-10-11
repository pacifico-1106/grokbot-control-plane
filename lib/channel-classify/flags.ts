/**
 * PR-B channel classification proposals / stuck notices flags. Kept out of
 * lib/feature-flags.ts on purpose (shared hot-path modules import these, and
 * several tests mock lib/feature-flags with a partial object). Both default OFF.
 */
function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/**
 * PR-B (八坂 2026-10-05): classification proposals for channels an employee
 * (or the org's own bot) joins — Slack member_joined_channel (bot + user event
 * subscription), LINE join (group / room), Telegram my_chat_member — plus the
 * Slack backfill (/api/cron/channel-classify-backfill) and the proposal opened
 * when a post is denied in an unregistered channel.
 *
 * When ON: facts are gathered (Slack conversations.info / members / users.info
 * with the org's own conversation bot token; LINE / Telegram: event only) and
 * channels.classify (+ parties.upsert for mixed Slack channels) tickets are
 * opened through the admin approval machinery (approvalClass admin,
 * always_human). Nothing is ever applied without a human approval. One open
 * ticket per org × channel; no reopen while pending or after a decision unless
 * the facts change. Requires migration 20261005200000.
 *
 * When OFF (default): join events are ignored exactly as before.
 */
export function isChannelClassifyProposalsEnabled(): boolean {
  return parseFlag(process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED);
}

/**
 * PR-B: never stop silently. When ON:
 * - a post denied with external_confidential_denied in an unregistered channel,
 * - a channel-ledger write / read failure, or a backfill failure,
 * - a Stuck Watch alert whose notifyMouth is unset or missing,
 * notify the employee's approval channel → the org's default approval channel
 * → ops (PLATFORM_OPS_ORG_ID audit mirror + APPROVAL_ALERT_OPS_EMAILS).
 * Ids and reason codes only (never a message body). One notice per org × kind
 * × channel per window. A notice failure never changes the deny.
 *
 * When OFF (default): unchanged (notify_mouth_unset stays a silent skip).
 */
export function isChannelStuckNotifyEnabled(): boolean {
  return parseFlag(process.env.CHANNEL_STUCK_NOTIFY_ENABLED);
}
