/**
 * F7 notifyMouth — deliver stuck watch alerts to a configured notification channel.
 */
import { appendAuditEvent, getEnabledNotificationChannels } from "@/lib/data";
import { sendLineText } from "@/lib/notify/line";
import { sendSlackTextToChannel } from "@/lib/notify/slack";
import { sendTelegramTextToChannel } from "@/lib/notify/telegram";
import { isChannelStuckNotifyEnabled } from "@/lib/channel-classify/flags";
import type { OrgStuckWatchPolicy } from "@/lib/types";

export type NotifyMouthResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  provider?: string;
  channelId?: string;
  error?: string;
};

export async function notifyStuckWatchMouth(
  orgId: string,
  policy: OrgStuckWatchPolicy,
  message: string,
  metadata: Record<string, unknown>
): Promise<NotifyMouthResult> {
  const mouth = (policy.notifyMouth || "").trim();
  if (!mouth) {
    if (isChannelStuckNotifyEnabled()) return fallbackToApprovalChannel(orgId, message, metadata);
    return { ok: true, skipped: true, reason: "notify_mouth_unset" };
  }

  const channels = await getEnabledNotificationChannels(orgId);
  const channel = channels.find((row) => row.id === mouth);
  if (!channel && isChannelStuckNotifyEnabled()) {
    return fallbackToApprovalChannel(orgId, message, metadata);
  }
  if (!channel) {
    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "notification.delivery_failed",
      purpose: "stuck_watch",
      summary: "Stuck Watch notifyMouth チャネルが見つかりません",
      metadata: { notifyMouth: mouth, ...metadata },
    }).catch(() => undefined);
    return {
      ok: false,
      reason: "notify_mouth_not_found",
      channelId: mouth,
      error: "channel_not_found_or_disabled",
    };
  }

  const sent =
    channel.provider === "telegram"
      ? await sendTelegramTextToChannel(channel, message)
      : channel.provider === "line"
        ? await sendLineText(channel, message)
        : await sendSlackTextToChannel(channel, message);

  if (!sent.ok) {
    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "notification.delivery_failed",
      purpose: "stuck_watch",
      summary: `Stuck Watch notifyMouth 通知に失敗（${channel.provider}）`,
      metadata: {
        notifyMouth: mouth,
        channelId: channel.id,
        error: sent.error,
        ...metadata,
      },
    }).catch(() => undefined);
    return {
      ok: false,
      provider: channel.provider,
      channelId: channel.id,
      error: sent.error,
    };
  }

  return {
    ok: true,
    provider: channel.provider,
    channelId: channel.id,
  };
}

/**
 * PR-B (CHANNEL_STUCK_NOTIFY_ENABLED): notifyMouth unset / missing → the
 * org's approval channel, then ops. Rate-limited per alert kind × code × item.
 */
async function fallbackToApprovalChannel(
  orgId: string,
  message: string,
  metadata: Record<string, unknown>
): Promise<NotifyMouthResult> {
  const { notifyChannelStuck } = await import("@/lib/channel-classify/stuck-notify");
  const part = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "-");
  const dedupeKey = [metadata.kind, metadata.code, metadata.itemId, metadata.tool].map(part).join("|");
  const result = await notifyChannelStuck({
    orgId,
    kind: "stuck_watch_mouth_fallback",
    reason: part(metadata.code),
    text: message,
    dedupeKey,
  });
  if (result.status === "suppressed") {
    return { ok: true, skipped: true, reason: "notify_mouth_fallback_suppressed" };
  }
  if (result.status === "sent_default" || result.status === "sent_approver") {
    return { ok: true, reason: "notify_mouth_fallback", channelId: result.channelId, provider: result.provider };
  }
  if (result.status === "sent_ops") {
    return { ok: true, reason: "notify_mouth_fallback", provider: "ops" };
  }
  return { ok: false, reason: "notify_mouth_fallback_undelivered", error: result.status };
}
