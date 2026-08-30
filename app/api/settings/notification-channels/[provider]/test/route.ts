import { NextResponse } from "next/server";
import {
  appendAuditEvent,
  getEnabledNotificationChannels,
} from "@/lib/data";
import { sendLineText } from "@/lib/notify/line";
import { sendSlackTextToChannel } from "@/lib/notify/slack";
import { sendTelegramTextToChannel } from "@/lib/notify/telegram";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { channelErrorPayload } from "@/lib/notify/channel-errors";
import type { NotificationProvider } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ provider: string }> }
) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const { provider: raw } = await ctx.params;
  if (raw !== "telegram" && raw !== "line" && raw !== "slack") {
    return NextResponse.json(channelErrorPayload("invalid_provider"), { status: 400 });
  }
  const provider = raw as NotificationProvider;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const requestedId = String(body.channelId || body.id || "").trim();
  const enabled = await getEnabledNotificationChannels(gate.orgId);
  const channel = requestedId
    ? enabled.find((item) => item.id === requestedId && item.provider === provider)
    : enabled.find((item) => item.provider === provider);
  if (!channel) return NextResponse.json(channelErrorPayload("enabled_channel_not_found"), { status: 404 });
  const message = "✅ StaffPass 通知チャネルのテストに成功しました。";
  const result = provider === "telegram"
    ? await sendTelegramTextToChannel(channel, message)
    : provider === "line"
      ? await sendLineText(channel, message)
      : await sendSlackTextToChannel(channel, message);
  await appendAuditEvent({
    orgId: gate.orgId,
    employeeId: null,
    credentialId: null,
    actorEmail: gate.email,
    action: "notification.test_sent",
    purpose: null,
    summary: `${provider} テスト通知`,
    metadata: { channelId: channel.id, ok: result.ok, error: result.error },
  });
  return NextResponse.json(
    result.ok
      ? { ok: true }
      : channelErrorPayload("notification_channel_save_failed", "テスト通知の送信に失敗しました"),
    { status: result.ok ? 200 : 502 }
  );
}
