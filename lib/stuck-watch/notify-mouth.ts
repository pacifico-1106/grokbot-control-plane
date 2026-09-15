/**
 * F7 notifyMouth — deliver stuck watch alerts to a configured notification channel.
 */
import { appendAuditEvent, getEnabledNotificationChannels } from "@/lib/data";
import { sendLineText } from "@/lib/notify/line";
import { sendSlackTextToChannel } from "@/lib/notify/slack";
import { sendTelegramTextToChannel } from "@/lib/notify/telegram";
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
    return { ok: true, skipped: true, reason: "notify_mouth_unset" };
  }

  const channels = await getEnabledNotificationChannels(orgId);
  const channel = channels.find((row) => row.id === mouth);
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
