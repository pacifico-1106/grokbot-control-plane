/**
 * Slack DM auto-route flags (PR-1). Kept out of lib/feature-flags.ts on purpose
 * (that file is touched by other open stacks). Both default OFF.
 */
function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/**
 * SLACK_USER_SCOPE_IM_WRITE: add `im:write` to the employee Slack OAuth
 * `user_scope` request. Turn ON only after `im:write` has been added to the
 * Staffpass Slack app's User Token Scopes (otherwise Slack rejects the OAuth
 * request with invalid_scope). Existing tokens are unaffected; employees must
 * re-authorize once to get the scope.
 */
export function isSlackUserScopeImWriteEnabled(): boolean {
  return parseFlag(process.env.SLACK_USER_SCOPE_IM_WRITE);
}

/**
 * SLACK_DM_AUTOROUTE_ENABLED: Plan A of DM auto-route.
 *
 * When ON:
 * - After an employee's Slack identity is linked, and after a human-approved
 *   parties.upsert of a slack_user, open the 1:1 DM between the employee and
 *   each org_parties internal slack_user (employee user token, conversations.open)
 *   and install the internal classification + IM route for that DM.
 * - Counterparts are checked with users.info (stranger / other team / guest /
 *   bot / deleted / undeterminable → skip, fail-closed). Existing external /
 *   mixed classifications and routes to another employee are never overwritten.
 * - Party downgraded to external, or employee Slack identity revoked → the
 *   auto-created routes are removed and the DM is reset to `unknown`.
 * - Every create / skip / failure / removal is audited as admin.channel
 *   (auditClass=admin → tenant dashboard change log). Tokens are never logged.
 * Requires migration 20261004000000_slack_im_route_autoroute.sql BEFORE turning ON.
 *
 * When OFF (default): no Slack calls, no DB writes, behavior identical to main.
 */
export function isSlackDmAutorouteEnabled(): boolean {
  return parseFlag(process.env.SLACK_DM_AUTOROUTE_ENABLED);
}

/**
 * SLACK_U_TO_DM_SEND_ENABLED (item C, default OFF): at send time, a Slack U…
 * user id placed in the channel field is resolved to the employee's internal
 * 1:1 DM route (internal ledger slack_user of the same org only, re-verified
 * with conversations.open as a 1:1 IM with exactly that user). Effective ONLY
 * when SLACK_DM_AUTOROUTE_ENABLED is also ON.
 *
 * Separate from SLACK_DM_AUTOROUTE_ENABLED on purpose: production already runs
 * with SLACK_DM_AUTOROUTE_ENABLED=1 (since 2026-10-04) and
 * SLACK_USER_SCOPE_IM_WRITE=1, so merging must not start the rewrite. With
 * this flag OFF a U… in the channel field ends exactly as on main
 * (403 egress_denied), and the #234 route sync is untouched.
 */
export function isSlackUToDmSendEnabled(): boolean {
  return parseFlag(process.env.SLACK_U_TO_DM_SEND_ENABLED) && isSlackDmAutorouteEnabled();
}
