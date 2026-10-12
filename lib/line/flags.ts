/**
 * LINE approval channel flags (2026-10-03, LINE approval gaps G1–G7).
 *
 * Kept out of lib/feature-flags.ts on purpose: several open PRs append to that
 * file, and these flags only matter to the LINE webhook / settings routes.
 * Every flag defaults OFF; OFF means today's production behavior.
 */

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/**
 * G1 + G4: one-time link code (連携コード) for LINE approvers.
 *
 * ON:
 * - A logged-in member with approval rights (owner/admin or approve_actions)
 *   can issue a 15-minute single-use code for THEMSELVES on one LINE approval
 *   channel (POST /api/settings/line-approver-link).
 * - Sending that code to the channel's LINE Official Account in a 1:1 chat
 *   proves control of both the Staffpass session and the LINE account; the
 *   webhook then records a verified voter binding (org × channel × LINE userId
 *   → member) and shows the LINE userId to the member in settings.
 * - Nothing is auto-filled into destinationId / allowedUserIds / approverUserIds.
 *
 * OFF (default): the settings API returns 404 and the webhook ignores codes
 * exactly like any other text from an unregistered sender.
 *
 * Requires: migration 20261003180000_line_approver_link_codes.sql and
 * VOTER_BINDING_SECRET (already required for voter bindings in production).
 */
export function isLineApproverLinkEnabled(): boolean {
  return parseFlag(process.env.LINE_APPROVER_LINK_ENABLED);
}

/**
 * G2: let employee approverUserIds entries match a LINE presser through a
 * verified voter binding instead of a raw LINE userId.
 *
 * ON:
 * - An entry equal to the bound member's id (org_members.id) or auth user id
 *   matches only when the presser has an active, verified binding for
 *   (same org, provider=line, this channel id, this LINE userId).
 * - `line:U…` entries match that LINE userId on LINE only; `slack:` /
 *   `telegram:` prefixed entries never match on LINE.
 *
 * OFF (default): exact raw-ID match only (today's behavior).
 */
export function isLineApproverBindingMatchEnabled(): boolean {
  return parseFlag(process.env.LINE_APPROVER_BINDING_MATCH);
}

/**
 * G5: answer the 修正依頼 button / text explicitly when the approval runs under
 * a multi-approver workflow (which does not support revision requests), instead
 * of dropping it silently. No state change besides clearing a stale
 * "awaiting revision" marker.
 */
export function isLineWorkflowRevisionReplyEnabled(): boolean {
  return parseFlag(process.env.LINE_WORKFLOW_REVISION_REPLY);
}

/**
 * G7: when a decision arrives through the LINE webhook (with a replyToken), send
 * the "✅ 承認済み …" follow-up in the same Reply as the acknowledgement instead
 * of a separate (billable) Push. Falls back to Push if the Reply fails.
 */
export function isLineResolveFollowupReplyEnabled(): boolean {
  return parseFlag(process.env.LINE_RESOLVE_FOLLOWUP_REPLY);
}
