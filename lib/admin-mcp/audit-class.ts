/**
 * Hire / scopes / parties / channels.classify are a SEPARATE audit class
 * from mail.send / comm.reply / tool.invoke. Dashboard change log leads
 * with this class only.
 *
 * Admin-class approvals require explicit account-approver policy when
 * admin_approver_enforcement is enabled at org or platform level.
 *
 * Classification is METADATA-DRIVEN: approval.metadata.approvalClass is
 * the primary source of truth, set at ticket creation. Legacy fallback
 * is used only for pre-existing rows that lack the field.
 */
export const ADMIN_AUDIT_ACTIONS = [
  "admin.hire",
  "admin.link",
  "admin.policy",
  "admin.parties",
  "admin.channel",
  "admin.role",
  "admin.ingressHandoff",
  "admin.conversationAdapter",
  "admin.notificationChannel",
  "admin.create_org",
  "admin.issue_admin_credential",
  "admin.proxy_approve",
  "admin.org_patch",
  "admin.billing",
  "admin.external_contract_card",
  "admin.portal",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export const ADMIN_TOOL_AUDIT_ACTION: Record<string, AdminAuditAction> = {
  "employees.issue": "admin.hire",
  link: "admin.link",
  "policy.patch": "admin.policy",
  "parties.upsert": "admin.parties",
  "channels.classify": "admin.channel",
  "roles.propose": "admin.role",
  "ingressHandoff.patch": "admin.ingressHandoff",
  "schedulingPolicy.patch": "admin.policy",
  "replyPolicy.patch": "admin.policy",
  "mailPolicy.patch": "admin.policy",
  "stuckWatch.patch": "admin.policy",
  "setup.slackAdapter.setBotToken": "admin.conversationAdapter",
  "setup.lineApproval.upsert": "admin.notificationChannel",
  "setup.lineApproval.setEmployeeInbox": "admin.notificationChannel",
  "setup.lineApproval.demoteTelegram": "admin.notificationChannel",
  "orgs.create": "admin.create_org",
  "orgs.issueAdminCredential": "admin.issue_admin_credential",
  "orgs.patch": "admin.org_patch",
  "approvalWorkflow.patch": "admin.policy",
  "internalAudienceRule.patch": "admin.policy",
  "approvalWorkflow.remind": "admin.policy",
  "approvalWorkflow.bindVoter": "admin.policy",
  "approvalWorkflow.unbindVoter": "admin.policy",
  "approvals.proxyResolve": "admin.proxy_approve",
  "employeeIdentity.upsert": "admin.policy",
  "employeeIdentity.bindMailbox": "admin.policy",
};

/** Operational / employee-badge class — never lead the dashboard change log. */
export const OPERATIONAL_AUDIT_ACTIONS = [
  "tool.invoke",
  "mail.send",
  "comm.reply",
  "comm.send",
  "slack.post",
  "sns.publish",
] as const;

const ADMIN_PREFIX = "admin.";

/** Hire-class aliases from the human dashboard (not tool.invoke). */
export const ADMIN_CLASS_ALIASES = [
  "credential.issued",
  "credential.revoked",
  "employee.created",
  "employee.updated",
  "employee.terminated",
] as const;

export function isAdminAuditAction(action: string | null | undefined): boolean {
  const value = (action || "").trim();
  if (!value) return false;
  if (value.startsWith(ADMIN_PREFIX)) return true;
  if ((ADMIN_AUDIT_ACTIONS as readonly string[]).includes(value)) return true;
  return (ADMIN_CLASS_ALIASES as readonly string[]).includes(value);
}

export function isOperationalAuditAction(action: string | null | undefined): boolean {
  const value = (action || "").trim();
  if (!value) return false;
  if (value === "tool.invoke") return true;
  if (value.startsWith("mail.") || value.startsWith("comm.") || value.startsWith("slack.")) {
    return true;
  }
  return (OPERATIONAL_AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function auditActionForAdminTool(tool: string): AdminAuditAction {
  return ADMIN_TOOL_AUDIT_ACTION[tool] ?? "admin.policy";
}

export function filterAdminChangeLogEvents<T extends { action: string }>(
  events: T[]
): T[] {
  return events.filter((event) => isAdminAuditAction(event.action));
}

export const ADMIN_AUDIT_CLASS = "admin" as const;
export const BUSINESS_AUDIT_CLASS = "business" as const;

export type ApprovalRouteClass = typeof ADMIN_AUDIT_CLASS | typeof BUSINESS_AUDIT_CLASS;

/**
 * LEGACY FALLBACK: Tool prefixes for classification when metadata.approvalClass is missing.
 * This is used only for pre-existing approval rows that were created before
 * metadata-driven classification was implemented.
 *
 * @deprecated New tickets should have metadata.approvalClass set at creation.
 */
const LEGACY_ADMIN_TOOL_PREFIXES = [
  "admin.",
  "setup.",
  "orgs.",
  "internalAudienceRule.",
  "approvalWorkflow.",
  "ingressHandoff.",
  "schedulingPolicy.",
  "replyPolicy.",
  "mailPolicy.",
  "stuckWatch.",
  "approvals.",
] as const;

/**
 * LEGACY FALLBACK: Explicit admin-class tools for pre-existing rows.
 * @deprecated New tickets should have metadata.approvalClass set at creation.
 */
const LEGACY_ADMIN_CLASS_TOOLS = new Set([
  "employees.issue",
  "link",
  "policy.patch",
  "parties.upsert",
  "channels.classify",
  "roles.propose",
]);

/**
 * Check if a tool is admin-class using LEGACY fallback logic.
 * Only used when metadata.approvalClass is not set.
 *
 * @deprecated Use metadata.approvalClass for new tickets.
 */
function isAdminClassToolLegacy(tool: string | null | undefined): boolean {
  const t = (tool || "").trim();
  if (!t) return false;
  if (LEGACY_ADMIN_CLASS_TOOLS.has(t)) return true;
  return LEGACY_ADMIN_TOOL_PREFIXES.some((prefix) => t.startsWith(prefix));
}

/**
 * Check if an approval is admin-class.
 *
 * Classification priority (METADATA-FIRST):
 * 1. metadata.approvalClass - PRIMARY source of truth for new tickets
 * 2. metadata.auditClass - Legacy field, still honored
 * 3. metadata.isAdminMcpTool + always_human - Admin MCP ticket marker
 * 4. purpose prefix "admin." - Audit action prefix
 * 5. LEGACY FALLBACK: tool name/prefix classification for pre-existing rows
 *
 * New tickets MUST have metadata.approvalClass set at creation.
 */
export function isAdminClassApproval(approval: {
  purpose?: string | null;
  tool?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  const meta = approval.metadata || {};

  if (meta.approvalClass === ADMIN_AUDIT_CLASS) return true;
  if (meta.approvalClass === BUSINESS_AUDIT_CLASS) return false;

  if (meta.auditClass === ADMIN_AUDIT_CLASS) return true;
  if (meta.auditClass === BUSINESS_AUDIT_CLASS) return false;

  if (meta.isAdminMcpTool === true) return true;

  const purpose = (approval.purpose || "").trim();
  if (purpose.startsWith("admin.")) return true;

  const tool = (approval.tool ?? meta.adminTool ?? meta.tool) as string | undefined;
  return isAdminClassToolLegacy(tool);
}

/**
 * Get the approval class for routing purposes.
 */
export function getApprovalRouteClass(approval: {
  purpose?: string | null;
  tool?: string | null;
  metadata?: Record<string, unknown> | null;
}): ApprovalRouteClass {
  return isAdminClassApproval(approval) ? ADMIN_AUDIT_CLASS : BUSINESS_AUDIT_CLASS;
}
