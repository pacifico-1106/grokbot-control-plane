/**
 * 運営からのお知らせ flags (design §8). Every flag defaults OFF; with all of them OFF the
 * application never reads or writes the operator-notice / ops-feedback tables and the MCP
 * tools/list is byte-identical to today.
 */
const ON = new Set(["true", "1", "on", "enabled"]);
const on = (v: string | undefined) => ON.has(String(v ?? "").trim().toLowerCase());

/** Tables, /admin/notices, staffpass_notices_list / ack, whoami.operatorNotices. */
export function isOperatorNoticesEnabled(): boolean {
  return on(process.env.OPERATOR_NOTICES_ENABLED);
}
/** urgent wake webhook (outbox + cron). Needs OPERATOR_NOTICES_ENABLED too. */
export function isOperatorNoticesWakeEnabled(): boolean {
  return isOperatorNoticesEnabled() && on(process.env.OPERATOR_NOTICES_WAKE_ENABLED);
}
/** /app/notices (tenant admin, read only). Needs OPERATOR_NOTICES_ENABLED too. */
export function isOperatorNoticesTenantViewEnabled(): boolean {
  return isOperatorNoticesEnabled() && on(process.env.OPERATOR_NOTICES_TENANT_VIEW_ENABLED);
}
/** staffpass_ops_report / ops_requests_list, /admin/feedback. */
export function isOpsFeedbackEnabled(): boolean {
  return on(process.env.OPS_FEEDBACK_ENABLED);
}
/** weekly digest cron. Needs OPS_FEEDBACK_ENABLED too. */
export function isOpsWeeklyDigestEnabled(): boolean {
  return isOpsFeedbackEnabled() && on(process.env.OPS_WEEKLY_DIGEST_ENABLED);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** OPERATOR_NOTICES_PILOT_ORG_IDS: comma list. Empty = everyone; invalid entries ignored. */
export function operatorNoticesPilotOrgIds(): string[] {
  return String(process.env.OPERATOR_NOTICES_PILOT_ORG_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => s && (UUID.test(s) || s.startsWith("org_"))).slice(0, 100);
}
/** The flag is on AND (no pilot list, or the org is in it). */
export function operatorNoticesEnabledForOrg(orgId: string): boolean {
  if (!isOperatorNoticesEnabled()) return false;
  const pilot = operatorNoticesPilotOrgIds();
  return pilot.length === 0 || pilot.includes(orgId);
}
