/**
 * Slack employee re-authorize link flags (B). Both default OFF.
 */
function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/**
 * SLACK_AUTHORIZE_LINK_ENABLED: admin MCP `setup.slackAuthorizeLink.issue`
 * (always_human) issues a per-employee, single-use, ~24h Slack authorize link,
 * delivered ONLY as an approval-app DM to an approver. The link start route
 * (/api/slack/oauth/link) and the link branch of /api/slack/oauth/callback
 * fail closed while OFF. Requires migration 20261004100000_slack_authorize_links.
 */
export function isSlackAuthorizeLinkEnabled(): boolean {
  return parseFlag(process.env.SLACK_AUTHORIZE_LINK_ENABLED);
}

/**
 * SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY (要判断 proposal): re-issue for an
 * ALREADY-LINKED employee whose user token only lacks `im:write` runs without a
 * ticket (admin audit row instead). The link stays pinned to the existing Slack
 * user + team, so it can only re-authorize the same account. Never applies to
 * unlinked employees, to an employee bound to the calling admin agent, or when
 * the token scopes cannot be read. Needs SLACK_AUTHORIZE_LINK_ENABLED too.
 */
export function isSlackAuthorizeLinkReissueAuditOnlyEnabled(): boolean {
  return parseFlag(process.env.SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY);
}
