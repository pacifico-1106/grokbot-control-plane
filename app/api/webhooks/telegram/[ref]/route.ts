import { NextResponse } from "next/server";
import { getNotificationChannelByWebhookRef } from "@/lib/data";
import { handleTelegramChannelUpdate } from "@/lib/notify/telegram-channel-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const channel = await getNotificationChannelByWebhookRef("telegram", ref);
  if (!channel) return NextResponse.json({ ok: true, ignored: true });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== channel.secrets.webhookSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const update = (await req.json().catch(() => ({}))) as Parameters<typeof handleTelegramChannelUpdate>[1];
  const result = await handleTelegramChannelUpdate(channel, update);
  return NextResponse.json({ ok: true, ...(result.ignored ? { ignored: true } : {}) });
}
