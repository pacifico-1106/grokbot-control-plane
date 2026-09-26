/**
 * Hire / scopes / parties / channels.classify are a SEPARATE audit class
 * from mail.send / comm.reply / tool.invoke. Dashboard change log leads
 * with this class only.
 *
 * Admin-class approvals require explicit account-approver policy when
 * ADMIN_APPROVER_POLICY_REQUIRED is enabled. Financial/billing/card-related
 * tools are classified admin so they never reach business approvers.
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
  "billing.patch": "admin.billing",
  "billing.update": "admin.billing",
  "externalContractCard.setup": "admin.external_contract_card",
  "externalContractCard.patch": "admin.external_contract_card",
  "portal.setup": "admin.portal",
  "portal.patch": "admin.portal",
  "setup.billing": "admin.billing",
  "setup.card": "admin.external_contract_card",
  "setup.portal": "admin.portal",
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
 * Admin-class tool prefixes: any tool whose name starts with these is admin-class.
 * This ensures future admin tools (setup.*, orgs.*, billing.*, etc.) are automatically
 * classified without requiring enumeration by name.
 */
const ADMIN_TOOL_PREFIXES = [
  "admin.",
  "setup.",
  "orgs.",
  "billing.",
  "portal.",
  "externalContractCard.",
  "internalAudienceRule.",
  "approvalWorkflow.",
] as const;

/**
 * Explicit admin-class tools that don't follow the prefix convention.
 * Employee-facing tools that modify account/org settings.
 */
const ADMIN_CLASS_TOOLS_EXPLICIT = new Set([
  "employees.issue",
  "link",
  "policy.patch",
  "parties.upsert",
  "channels.classify",
  "roles.propose",
  "ingressHandoff.patch",
  "schedulingPolicy.patch",
  "replyPolicy.patch",
  "mailPolicy.patch",
  "stuckWatch.patch",
]);

/**
 * Check if a tool is admin-class by class membership (not by name enumeration).
 * Admin-class tools require explicit admin route policy when flag is enabled.
 */
export function isAdminClassTool(tool: string | null | undefined): boolean {
  const t = (tool || "").trim();
  if (!t) return false;
  if (ADMIN_CLASS_TOOLS_EXPLICIT.has(t)) return true;
  return ADMIN_TOOL_PREFIXES.some((prefix) => t.startsWith(prefix));
}

export function isAdminClassApproval(approval: {
  purpose?: string | null;
  tool?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  const meta = approval.metadata || {};
  if (meta.auditClass === ADMIN_AUDIT_CLASS) return true;
  if (meta.always_human === true && typeof meta.adminTool === "string") return true;
  const purpose = (approval.purpose || "").trim();
  if (purpose.startsWith("admin.")) return true;
  const tool = (approval.tool ?? meta.adminTool ?? meta.tool) as string | undefined;
  return isAdminClassTool(tool);
}

/**
 * Get the approval class for routing purposes.
 * Admin-class requires explicit admin route policy when ADMIN_APPROVER_POLICY_REQUIRED is enabled.
 */
export function getApprovalRouteClass(approval: {
  purpose?: string | null;
  tool?: string | null;
  metadata?: Record<string, unknown> | null;
}): ApprovalRouteClass {
  return isAdminClassApproval(approval) ? ADMIN_AUDIT_CLASS : BUSINESS_AUDIT_CLASS;
}
