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
