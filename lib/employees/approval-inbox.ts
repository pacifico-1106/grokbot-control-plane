import type { NotificationChannel } from "@/lib/types";

export function normalizeApproverUserIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  return [...new Set(list.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

export function parseApprovalChannelId(
  raw: unknown,
  knownIds: string[]
): { ok: true; id: string | null } | { ok: false } {
  if (raw == null) return { ok: true, id: null };
  const id = String(raw).trim();
  if (!id) return { ok: true, id: null };
  if (!knownIds.includes(id)) return { ok: false };
  return { ok: true, id };
}

export function extraApproversAllow(
  userId: string | number | null | undefined,
  extra: string[] | undefined | null
): boolean {
  const id = String(userId ?? "").trim();
  const list = extra ?? [];
  if (list.length === 0) return true;
  return Boolean(id) && list.includes(id);
}

export type LineApproverGateResult =
  | { allowed: true; via: "open" | "raw_id" | "provider_scoped" | "binding" }
  | { allowed: false; reason: "missing_user_id" | "employee_not_found" | "not_listed" };

/**
 * G2: match a LINE presser against the employee's approverUserIds.
 *
 * Always (stricter than the old extraApproversAllow path):
 * - no LINE userId → deny (never act as "line:unknown")
 * - the approval names an employee but it cannot be loaded → deny (fail-closed;
 *   previously `undefined` approverUserIds meant "anyone")
 * - raw entries match the LINE userId exactly (case-sensitive, no trimming)
 *
 * bindingMatch (LINE_APPROVER_BINDING_MATCH, default OFF) additionally allows:
 * - `line:<userId>` entries (provider-scoped; `slack:` / `telegram:` never match here)
 * - Staffpass member id / auth user id entries, ONLY via a verified voter binding
 *   for this org × LINE channel × LINE userId (the caller passes that binding)
 */
export function lineApproverGate(input: {
  lineUserId: string | null | undefined;
  approvalEmployeeId: string | null | undefined;
  employee: { approverUserIds?: string[] | null } | null | undefined;
  binding?: { memberId: string; memberUserId?: string | null } | null;
  bindingMatch: boolean;
}): LineApproverGateResult {
  const userId = typeof input.lineUserId === "string" ? input.lineUserId : "";
  if (!userId) return { allowed: false, reason: "missing_user_id" };
  if (input.approvalEmployeeId && !input.employee) return { allowed: false, reason: "employee_not_found" };
  const entries = (input.employee?.approverUserIds ?? []).map(String).filter(Boolean);
  if (entries.length === 0) return { allowed: true, via: "open" };
  if (entries.includes(userId)) return { allowed: true, via: "raw_id" };
  if (input.bindingMatch) {
    if (entries.includes(`line:${userId}`)) return { allowed: true, via: "provider_scoped" };
    const binding = input.binding;
    if (binding?.memberId) {
      if (entries.includes(binding.memberId)) return { allowed: true, via: "binding" };
      if (binding.memberUserId && entries.includes(binding.memberUserId)) return { allowed: true, via: "binding" };
    }
  }
  return { allowed: false, reason: "not_listed" };
}

export function inboxOptionLabel(channel: NotificationChannel): string {
  const mark = channel.isDefault ? "（既定）" : "";
  const provider =
    channel.provider === "telegram"
      ? "Telegram"
      : channel.provider === "line"
        ? "LINE"
        : "Slack";
  return `${channel.label || provider}${mark}`;
}

export function assignedInboxLabel(
  employee: { approvalChannelId?: string | null },
  channels: NotificationChannel[]
): string {
  const requested = employee.approvalChannelId?.trim() || "";
  const chosen = requested
    ? channels.find((channel) => channel.id === requested)
    : channels.find((channel) => channel.isDefault) ?? channels[0];
  if (!chosen) return "未設定";
  return inboxOptionLabel(chosen);
}
