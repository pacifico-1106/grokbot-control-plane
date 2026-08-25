import { NextResponse } from "next/server";
import {
  appendAuditEvent,
  getEnabledNotificationChannels,
} from "@/lib/data";
import { sendLineText } from "@/lib/notify/line";
import { sendTelegramTextToChannel } from "@/lib/notify/telegram";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import type { NotificationProvider } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ provider: string }> }
) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const { provider: raw } = await ctx.params;
  if (raw !== "telegram" && raw !== "line") {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }
  const provider = raw as NotificationProvider;
  const channel = (await getEnabledNotificationChannels(gate.orgId)).find(
    (item) => item.provider === provider
  );
  if (!channel) return NextResponse.json({ error: "enabled_channel_not_found" }, { status: 404 });
  const message = "✅ StaffPass 通知チャネルのテストに成功しました。";
  const result = provider === "telegram"
    ? await sendTelegramTextToChannel(channel, message)
    : await sendLineText(channel, message);
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
  return NextResponse.json({ ok: result.ok, error: result.error }, { status: result.ok ? 200 : 502 });
}
