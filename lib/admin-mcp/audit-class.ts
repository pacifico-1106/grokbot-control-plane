/**
 * Hire / scopes / parties / channels.classify are a SEPARATE audit class
 * from mail.send / comm.reply / tool.invoke. Dashboard change log leads
 * with this class only.
 */
export const ADMIN_AUDIT_ACTIONS = [
  "admin.hire",
  "admin.link",
  "admin.policy",
  "admin.parties",
  "admin.channel",
  "admin.role",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export const ADMIN_TOOL_AUDIT_ACTION: Record<string, AdminAuditAction> = {
  "employees.issue": "admin.hire",
  link: "admin.link",
  "policy.patch": "admin.policy",
  "parties.upsert": "admin.parties",
  "channels.classify": "admin.channel",
  "roles.propose": "admin.role",
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

export function isAdminAuditAction(action: string | null | undefined): boolean {
  const value = (action || "").trim();
  if (!value) return false;
  if (value.startsWith(ADMIN_PREFIX)) return true;
  return (ADMIN_AUDIT_ACTIONS as readonly string[]).includes(value);
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

export function isAdminClassApproval(approval: {
  purpose?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  const meta = approval.metadata || {};
  if (meta.auditClass === ADMIN_AUDIT_CLASS) return true;
  if (meta.always_human === true && typeof meta.adminTool === "string") return true;
  return (approval.purpose || "").trim().startsWith("admin.");
}
