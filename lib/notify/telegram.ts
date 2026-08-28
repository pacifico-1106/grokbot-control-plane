import { getAppOrigin } from "@/lib/approvals/tokens";
import {
  getApprovalById,
  updateApprovalTelegramState,
} from "@/lib/data/approvals";
import {
  getNotificationDelivery,
  recordNotificationDelivery,
  shouldUseGlobalTelegramFallback,
  type NotificationChannelRuntime,
} from "@/lib/data/notification-channels";
import type { ApprovalRequest, Employee } from "@/lib/types";

const TELEGRAM_TIMEOUT_MS = 5_000;

export type TelegramResult = {
  ok: boolean;
  skipped?: boolean;
  messageId?: number;
  error?: string;
};

export type TelegramTarget = {
  token: string;
  chatId: string;
  allowedUserIds?: string[];
};

function config() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
    chatId: process.env.TELEGRAM_APPROVAL_CHAT_ID?.trim() || "",
  };
}

export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}

function safeArtifactUrl(approval: ApprovalRequest): string | null {
  const raw = approval.metadata.artifact_url ?? approval.metadata.artifactUrl;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const TELEGRAM_MESSAGE_MAX = 4096;
const TELEGRAM_OVERFLOW_SUFFIX = "…(続きはダッシュボード)";

function composeApprovalTelegramMessage(
  approval: ApprovalRequest,
  employee: Employee | null,
  summary: string
): string {
  const artifactUrl = safeArtifactUrl(approval);
  const lines = [
    `🟡 <b>承認依頼 #${escapeTelegramHtml(approval.id.slice(0, 8))}</b>  [risk: ${escapeTelegramHtml(approval.risk)}]`,
    `社員: ${escapeTelegramHtml(employee?.displayName || approval.employeeId)}`,
    `ツール: <code>${escapeTelegramHtml(approval.tool || "unknown")}</code>`,
    `目的: ${escapeTelegramHtml(approval.purpose)}`,
    "─",
    escapeTelegramHtml(summary),
    "─",
    `job: <code>${escapeTelegramHtml(approval.jobId || "-")}</code>${
      approval.revisionCount > 0
        ? `   再提出: ${approval.revisionCount + 1}回目`
        : ""
    }`,
  ];
  if (artifactUrl) {
    lines.push(
      `成果物: <a href="${escapeTelegramHtml(artifactUrl)}">確認する</a>`
    );
  }
  return lines.join("\n");
}

export function buildApprovalTelegramMessage(
  approval: ApprovalRequest,
  employee: Employee | null
): string {
  // Keep the full body in DB summary; only trim the Telegram send payload.
  const summary = approval.summary || "";
  let text = composeApprovalTelegramMessage(approval, employee, summary);
  if (Array.from(text).length <= TELEGRAM_MESSAGE_MAX) return text;
  const suffix = TELEGRAM_OVERFLOW_SUFFIX;
  let chars = Array.from(summary);
  while (chars.length > 0) {
    const candidate = chars.join("") + suffix;
    text = composeApprovalTelegramMessage(approval, employee, candidate);
    if (Array.from(text).length <= TELEGRAM_MESSAGE_MAX) return text;
    const over = Array.from(text).length - TELEGRAM_MESSAGE_MAX;
    chars = chars.slice(0, Math.max(0, chars.length - Math.max(1, over)));
  }
  return composeApprovalTelegramMessage(approval, employee, suffix);
}

async function callTelegram<T = Record<string, unknown>>(
  method: string,
  payload: Record<string, unknown>,
  tokenOverride?: string
): Promise<{ ok: boolean; result?: T; error?: string }> {
  const token = tokenOverride || config().token;
  if (!token) return { ok: false, error: "telegram_not_configured" };
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      }
    );
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!response.ok || !body.ok) {
      return {
        ok: false,
        error: body.description || `telegram_http_${response.status}`,
      };
    }
    return { ok: true, result: body.result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "telegram_fetch_failed",
    };
  }
}

export function telegramTargetFromChannel(
  channel: NotificationChannelRuntime
): TelegramTarget | null {
  const token = channel.secrets.botToken?.trim() || "";
  const chatId = String(channel.config.chatId || "").trim();
  if (!token || !chatId) return null;
  return {
    token,
    chatId,
    allowedUserIds: Array.isArray(channel.config.allowedUserIds)
      ? channel.config.allowedUserIds.map(String)
      : [],
  };
}

export async function sendApprovalToTelegramChannel(
  approval: ApprovalRequest,
  employee: Employee | null,
  channel: NotificationChannelRuntime
): Promise<TelegramResult> {
  const target = telegramTargetFromChannel(channel);
  if (!target || !approval.telegramRef) return { ok: false, skipped: true };
  let replyToMessageId: number | undefined;
  if (approval.parentApprovalId) {
    const parentDelivery = await getNotificationDelivery({
      approvalId: approval.parentApprovalId,
      channelId: channel.id,
    });
    const parsed = Number(parentDelivery?.externalMessageId);
    if (Number.isSafeInteger(parsed)) replyToMessageId = parsed;
  }
  const sent = await callTelegram<{ message_id?: number }>(
    "sendMessage",
    {
      chat_id: target.chatId,
      text: buildApprovalTelegramMessage(approval, employee),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyToMessageId
        ? {
            reply_parameters: {
              message_id: replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ 承認", callback_data: `a:${approval.telegramRef}` },
          { text: "❌ 却下", callback_data: `r:${approval.telegramRef}` },
          { text: "✏️ 修正", callback_data: `e:${approval.telegramRef}` },
        ]],
      },
    },
    target.token
  );
  const messageId = Number(sent.result?.message_id);
  if (!sent.ok || !Number.isSafeInteger(messageId)) {
    return { ok: false, error: sent.error || "telegram_message_id_missing" };
  }
  await recordNotificationDelivery({
    approval,
    channelId: channel.id,
    provider: "telegram",
    externalMessageId: String(messageId),
  });
  return { ok: true, messageId };
}

export async function editTelegramApprovalForChannel(
  approval: ApprovalRequest,
  status: "approved" | "rejected" | "revision_requested",
  actor: string,
  channel: NotificationChannelRuntime
): Promise<TelegramResult> {
  const target = telegramTargetFromChannel(channel);
  const delivery = await getNotificationDelivery({
    approvalId: approval.id,
    channelId: channel.id,
  });
  const messageId = Number(delivery?.externalMessageId);
  if (!target || !Number.isSafeInteger(messageId)) return { ok: false, skipped: true };
  const label = status === "approved" ? "✅ 承認済み" : status === "rejected" ? "❌ 却下済み" : "✏️ 修正依頼済み";
  const note = status === "revision_requested" && approval.revisionNote
    ? `\n指示: ${escapeTelegramHtml(truncate(approval.revisionNote, 400))}`
    : "";
  const edited = await callTelegram("editMessageText", {
    chat_id: target.chatId,
    message_id: messageId,
    text: `${label}\n<b>${escapeTelegramHtml(approval.title)}</b>${note}\n処理者: ${escapeTelegramHtml(actor)}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  }, target.token);
  return edited.ok ? { ok: true } : { ok: false, error: edited.error };
}

export async function promptTelegramRevisionForChannel(
  approval: ApprovalRequest,
  userId: number,
  channel: NotificationChannelRuntime
): Promise<TelegramResult> {
  const target = telegramTargetFromChannel(channel);
  const delivery = await getNotificationDelivery({ approvalId: approval.id, channelId: channel.id });
  const messageId = Number(delivery?.externalMessageId);
  if (!target || !Number.isSafeInteger(messageId)) return { ok: false, skipped: true };
  const updated = await updateApprovalTelegramState(approval, {
    awaitingRevisionFrom: userId,
    awaitingRevisionChannelId: channel.id,
    awaitingRevisionProvider: "telegram",
  });
  if (!updated) return { ok: false, error: "revision_state_update_failed" };
  const edited = await callTelegram("editMessageText", {
    chat_id: target.chatId,
    message_id: messageId,
    text: `${buildApprovalTelegramMessage(approval, null)}\n\n✏️ <b>修正指示をこのメッセージへの返信で送ってください</b>`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  }, target.token);
  if (!edited.ok) {
    await updateApprovalTelegramState(updated, {
      awaitingRevisionFrom: null,
      awaitingRevisionChannelId: null,
      awaitingRevisionProvider: null,
    });
  }
  return edited.ok ? { ok: true } : { ok: false, error: edited.error };
}

export async function sendTelegramTextToChannel(
  channel: NotificationChannelRuntime,
  text: string,
  replyToMessageId?: number
): Promise<TelegramResult> {
  const target = telegramTargetFromChannel(channel);
  if (!target) return { ok: false, skipped: true };
  const sent = await callTelegram<{ message_id?: number }>("sendMessage", {
    chat_id: target.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
  }, target.token);
  return sent.ok ? { ok: true } : { ok: false, error: sent.error };
}

export async function answerTelegramCallbackForChannel(
  channel: NotificationChannelRuntime,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  const target = telegramTargetFromChannel(channel);
  if (!target || !callbackQueryId) return;
  await callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: truncate(text, 180) } : {}),
  }, target.token);
}

export async function registerTelegramWebhook(
  channel: NotificationChannelRuntime,
  absoluteWebhookUrl: string
): Promise<TelegramResult> {
  const target = telegramTargetFromChannel(channel);
  const secret = channel.secrets.webhookSecret?.trim();
  if (!target || !secret) return { ok: false, error: "telegram_credentials_incomplete" };
  const result = await callTelegram("setWebhook", {
    url: absoluteWebhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  }, target.token);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * グローバル fallback bot（TELEGRAM_BOT_TOKEN）に callback_query 用 webhook を張る。
 * token / secret が無いときは throw せず skip。
 */
export async function ensureGlobalTelegramWebhook(): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || "";
  if (!token || !secret) return { ok: false, skipped: true };
  const url = `${getAppOrigin()}/api/webhooks/telegram`;
  const result = await callTelegram("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
  if (!result.ok) {
    console.error("telegram_global_setWebhook_failed", result.error);
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

export async function sendApprovalToTelegram(
  approval: ApprovalRequest,
  employee: Employee | null
): Promise<TelegramResult> {
  if (!(await shouldUseGlobalTelegramFallback(approval.orgId))) {
    return { ok: false, skipped: true };
  }
  const { token, chatId } = config();
  if (!token || !chatId) return { ok: false, skipped: true };
  if (!approval.telegramRef) {
    return { ok: false, error: "telegram_ref_missing" };
  }

  // 初回の live notify でも callback が届くよう、送信前にグローバル webhook を武装する
  await ensureGlobalTelegramWebhook();

  const parent = approval.parentApprovalId
    ? await getApprovalById(approval.parentApprovalId, approval.orgId)
    : null;
  const sent = await callTelegram<{ message_id?: number }>("sendMessage", {
    chat_id: chatId,
    text: buildApprovalTelegramMessage(approval, employee),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(parent?.telegramMessageId
      ? {
          reply_parameters: {
            message_id: parent.telegramMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ 承認", callback_data: `a:${approval.telegramRef}` },
          { text: "❌ 却下", callback_data: `r:${approval.telegramRef}` },
          { text: "✏️ 修正", callback_data: `e:${approval.telegramRef}` },
        ],
      ],
    },
  });
  const messageId = Number(sent.result?.message_id);
  if (!sent.ok || !Number.isSafeInteger(messageId)) {
    return { ok: false, error: sent.error || "telegram_message_id_missing" };
  }
  const linked = await updateApprovalTelegramState(approval, {
    telegramMessageId: messageId,
  });
  if (!linked) {
    await callTelegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "⚠️ StaffPassとの紐付けに失敗したため、この通知からは操作できません。Web画面を確認してください。",
      reply_markup: { inline_keyboard: [] },
    });
  }
  return linked
    ? { ok: true, messageId }
    : { ok: false, messageId, error: "telegram_message_link_failed" };
}

export async function editTelegramApprovalMessage(
  approval: ApprovalRequest,
  status: "approved" | "rejected" | "revision_requested",
  actor: string
): Promise<TelegramResult> {
  if (!(await shouldUseGlobalTelegramFallback(approval.orgId))) {
    return { ok: false, skipped: true };
  }
  const { chatId } = config();
  if (!chatId || !approval.telegramMessageId) {
    return { ok: false, skipped: true };
  }
  const label =
    status === "approved"
      ? "✅ 承認済み"
      : status === "rejected"
        ? "❌ 却下済み"
        : "✏️ 修正依頼済み";
  const note =
    status === "revision_requested" && approval.revisionNote
      ? `\n指示: ${escapeTelegramHtml(truncate(approval.revisionNote, 400))}`
      : "";
  const edited = await callTelegram("editMessageText", {
    chat_id: chatId,
    message_id: approval.telegramMessageId,
    text: `${label}\n<b>${escapeTelegramHtml(approval.title)}</b>${note}\n処理者: ${escapeTelegramHtml(actor)}\n時刻: ${escapeTelegramHtml(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }))} JST`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  });
  return edited.ok ? { ok: true } : { ok: false, error: edited.error };
}

export async function promptTelegramRevision(
  approval: ApprovalRequest,
  userId: number
): Promise<TelegramResult> {
  if (!(await shouldUseGlobalTelegramFallback(approval.orgId))) {
    return { ok: false, skipped: true };
  }
  const { chatId } = config();
  if (!chatId || !approval.telegramMessageId) {
    return { ok: false, skipped: true };
  }
  const updated = await updateApprovalTelegramState(approval, {
    awaitingRevisionFrom: userId,
  });
  if (!updated) return { ok: false, error: "revision_state_update_failed" };
  const edited = await callTelegram("editMessageText", {
    chat_id: chatId,
    message_id: approval.telegramMessageId,
    text: `${buildApprovalTelegramMessage(approval, null)}\n\n✏️ <b>修正指示をこのメッセージへの返信で送ってください</b>`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  });
  if (!edited.ok) {
    await updateApprovalTelegramState(updated, { awaitingRevisionFrom: null });
  }
  return edited.ok ? { ok: true } : { ok: false, error: edited.error };
}

export async function answerTelegramCallback(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  if (!callbackQueryId) return;
  await callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: truncate(text, 180) } : {}),
  });
}

export async function sendTelegramText(
  text: string,
  replyToMessageId?: number
): Promise<TelegramResult> {
  const { token, chatId } = config();
  if (!token || !chatId) return { ok: false, skipped: true };
  const sent = await callTelegram<{ message_id?: number }>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyToMessageId
      ? {
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
  });
  const messageId = Number(sent.result?.message_id);
  return sent.ok
    ? { ok: true, ...(Number.isSafeInteger(messageId) ? { messageId } : {}) }
    : { ok: false, error: sent.error };
}
