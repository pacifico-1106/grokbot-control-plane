import { NextResponse } from "next/server";
import { getNotificationChannelByWebhookRef } from "@/lib/data";
import { handleTelegramChannelUpdate } from "@/lib/notify/telegram-channel-webhook";
import {
  handleTelegramVerificationConfirm,
  handleTelegramVerificationReject,
} from "@/lib/approval-workflow/telegram-binding-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 5000;

function formatJstTimestamp(): string {
  return new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

async function answerCallback(
  botToken: string,
  callbackId: string,
  text: string,
  showAlert = false
): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text,
        show_alert: showAlert,
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("telegram_answer_callback_failed", {
      callbackId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function editMessageText(
  botToken: string,
  chatId: string | number,
  messageId: number,
  text: string
): Promise<boolean> {
  try {
    const response = await fetch(`${TELEGRAM_API}/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: { inline_keyboard: [] },
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
    if (!body.ok) {
      console.error("telegram_edit_message_failed", {
        chatId,
        messageId,
        error: body.description,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error("telegram_edit_message_error", {
      chatId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
      const botToken = channel.secrets.botToken || "";
      const callbackId = query.id || "";
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;

      if (action === "c") {
        const result = await handleTelegramVerificationConfirm({
          callbackValue,
          presserTelegramUserId,
          expectedChannelKey: channel.id,
          expectedOrgId: channel.orgId,
        });

        if (result.ok) {
          const successText = `✅ 承認者登録が完了しました（${formatJstTimestamp()} JST）`;
          if (chatId && messageId) {
            await editMessageText(botToken, chatId, messageId, successText);
          }
          await answerCallback(botToken, callbackId, "✅ 承認者として登録されました", true);
        } else {
          await answerCallback(botToken, callbackId, result.messageJa, true);
        }
      } else {
        const result = await handleTelegramVerificationReject({
          callbackValue,
          presserTelegramUserId,
        });

        if (result.ok) {
          const rejectText = `❌ 登録を拒否しました（${formatJstTimestamp()} JST）`;
          if (chatId && messageId) {
            await editMessageText(botToken, chatId, messageId, rejectText);
          }
          await answerCallback(botToken, callbackId, "❌ 登録を拒否しました", true);
        } else {
          await answerCallback(botToken, callbackId, result.messageJa, true);
        }
      }
      return NextResponse.json({ ok: true });
    }
  }

  const result = await handleTelegramChannelUpdate(channel, update);
  return NextResponse.json({ ok: true, ...(result.ignored ? { ignored: true } : {}) });
}
