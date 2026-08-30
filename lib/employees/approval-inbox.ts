import type { NotificationChannel } from "@/lib/types";

export function normalizeApproverUserIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  return [...new Set(list.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
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
