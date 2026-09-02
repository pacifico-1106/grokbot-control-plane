import {
  filterAdminChangeLogEvents,
  isAdminAuditAction,
  isOperationalAuditAction,
} from "@/lib/admin-mcp/audit-class";

export type ChangeLogEvent = {
  id?: string;
  action: string;
  summary?: string | null;
  createdAt: string;
  employeeId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function leadChangeLogEvents<T extends ChangeLogEvent>(events: T[]): T[] {
  return filterAdminChangeLogEvents(events);
}

export function excludeOperationalFromLead<T extends { action: string }>(
  events: T[]
): T[] {
  return events.filter(
    (event) => isAdminAuditAction(event.action) && !isOperationalAuditAction(event.action)
  );
}

export const CHANGE_LOG_EMPTY_JA = "まだ雇用・権限・相手台帳の変更はありません";
export const CHANGE_LOG_LEAD_JA = "雇用・権限・相手台帳の変更";
