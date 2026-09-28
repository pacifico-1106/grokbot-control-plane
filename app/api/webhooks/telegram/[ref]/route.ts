import { NextResponse } from "next/server";
import { getNotificationChannelByWebhookRef } from "@/lib/data";
import { handleTelegramChannelUpdate } from "@/lib/notify/telegram-channel-webhook";
import {
  handleTelegramVerificationConfirm,
  handleTelegramVerificationReject,
  parseTelegramVerificationCallbackValue,
} from "@/lib/approval-workflow/telegram-binding-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TELEGRAM_API = "https://api.telegram.org";

async function answerCallback(botToken: string, callbackId: string, text: string): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* ignore */
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const channel = await getNotificationChannelByWebhookRef("telegram", ref);
  if (!channel) return NextResponse.json({ ok: true, ignored: true });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== channel.secrets.webhookSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const update = (await req.json().catch(() => ({}))) as Parameters<typeof handleTelegramChannelUpdate>[1];

  const query = update.callback_query;
  if (query?.data) {
    const vbMatch = /^vb:(c|r):(.+)$/.exec(query.data);
    if (vbMatch) {
      const action = vbMatch[1];
      const callbackValue = vbMatch[2];
      const presserTelegramUserId = String(query.from?.id ?? "");

      const parsed = parseTelegramVerificationCallbackValue(callbackValue);
      if (!parsed.ok) {
        await answerCallback(channel.secrets.botToken || "", query.id || "", "検証データが不正です");
        return NextResponse.json({ ok: true });
      }

      if (parsed.channelKey !== channel.id) {
        await answerCallback(channel.secrets.botToken || "", query.id || "", "チャネルが一致しません");
        return NextResponse.json({ ok: true });
      }

      if (parsed.orgId !== channel.orgId) {
        await answerCallback(channel.secrets.botToken || "", query.id || "", "組織が一致しません");
        return NextResponse.json({ ok: true });
      }

      if (action === "c") {
        const result = await handleTelegramVerificationConfirm({
          callbackValue,
          presserTelegramUserId,
        });
        await answerCallback(channel.secrets.botToken || "", query.id || "", result.messageJa);
      } else {
        const result = await handleTelegramVerificationReject({
          callbackValue,
          presserTelegramUserId,
        });
        await answerCallback(channel.secrets.botToken || "", query.id || "", result.messageJa);
      }
      return NextResponse.json({ ok: true });
    }
  }

  const result = await handleTelegramChannelUpdate(channel, update);
  return NextResponse.json({ ok: true, ...(result.ignored ? { ignored: true } : {}) });
}
