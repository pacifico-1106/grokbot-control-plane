/**
 * Telegram-based identity verification for voter bindings (telegram:global).
 *
 * P0 Fix: When binding an org owner to telegram:global:
 * 1. Send a one-time confirmation button to the Telegram user via the global bot
 * 2. User must click the confirm button (callback_query)
 * 3. Binding becomes active only after successful verification
 *
 * Security:
 * - Only org owners can bind to telegram:global
 * - Verification uses HMAC-signed callback data
 * - 15-minute expiry on verification codes
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import {
  generateVerificationCode,
  verifyVoterBinding,
  type VoterBinding,
  type VoterBindingProvider,
} from "./voter-binding";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10_000;

function getCallbackSecret(): string {
  const secret = process.env.VOTER_BINDING_SECRET;
  if (isDemoMode()) {
    return secret || "dev-secret";
  }
  if (!secret || secret.trim() === "" || secret === "dev-secret") {
    throw new Error("VOTER_BINDING_SECRET must be configured in production");
  }
  return secret;
}

function getTelegramBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

export interface SendTelegramVerificationInput {
  telegramUserId: string;
  orgId: string;
  memberId: string;
  memberDisplayName: string;
  orgName: string;
  verificationCode: string;
  channelKey?: string;
}

export interface TelegramVerificationResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

export async function sendVerificationToTelegramUser(
  input: SendTelegramVerificationInput
): Promise<TelegramVerificationResult> {
  const botToken = getTelegramBotToken();
  if (!botToken || !input.telegramUserId?.trim()) {
    return { ok: false, error: "missing_credentials" };
  }

  const channelKey = input.channelKey || TELEGRAM_GLOBAL_CHANNEL_KEY;
  const callbackValue = buildTelegramVerificationCallbackValue({
    orgId: input.orgId,
    telegramUserId: input.telegramUserId,
    verificationCode: input.verificationCode,
    channelKey,
  });

  const text = `*Staffpass 承認者登録の確認*\n\n` +
    `組織「${escapeTelegramMarkdown(input.orgName)}」で、あなたのアカウントを承認者「${escapeTelegramMarkdown(input.memberDisplayName)}」として登録しようとしています。\n\n` +
    `このバインディングを承認すると、あなたは承認ワークフローでチケットを承認・却下できるようになります。\n\n` +
    `確認コード: \`${input.verificationCode}\`\n\n` +
    `_この確認は15分で期限切れになります。心当たりがない場合は「拒否」をクリックしてください。_`;

  const inlineKeyboard = [
    [
      { text: "✅ 承認者として登録する", callback_data: `vb:c:${callbackValue}` },
    ],
    [
      { text: "❌ 拒否する", callback_data: `vb:r:${callbackValue}` },
    ],
  ];

  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.telegramUserId,
        text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    };

    if (!body.ok) {
      console.error("telegram_verification_dm_failed", {
        telegramUserId: input.telegramUserId,
        error: body.description,
      });
      return { ok: false, error: body.description || "send_failed" };
    }

    return { ok: true, messageId: body.result?.message_id };
  } catch (error) {
    console.error("telegram_verification_dm_error", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "network_error",
    };
  }
}

export interface SendTelegramVerificationViaChannelInput {
  telegramUserId: string;
  orgId: string;
  memberId: string;
  memberDisplayName: string;
  orgName: string;
  verificationCode: string;
  channelId: string;
  botToken: string;
}

export interface TelegramVerificationViaChannelResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  nextStepJa?: string;
}

/**
 * Send verification DM via a tenant channel's bot token.
 * Used when binding a voter to a tenant-specific Telegram channel.
 *
 * Note: This only works if the user has already started a conversation
 * with the channel's bot. If not, Telegram will reject the send and
 * we return a clear nextStepJa instructing the user to start the bot.
 */
export async function sendVerificationToTelegramUserViaChannel(
  input: SendTelegramVerificationViaChannelInput
): Promise<TelegramVerificationViaChannelResult> {
  const botToken = input.botToken?.trim();
  if (!botToken || !input.telegramUserId?.trim()) {
    return { ok: false, error: "missing_credentials" };
  }

  const callbackValue = buildTelegramVerificationCallbackValue({
    orgId: input.orgId,
    telegramUserId: input.telegramUserId,
    verificationCode: input.verificationCode,
    channelKey: input.channelId,
  });

  const text = `*Staffpass 承認者登録の確認*\n\n` +
    `組織「${escapeTelegramMarkdown(input.orgName)}」で、あなたのアカウントを承認者「${escapeTelegramMarkdown(input.memberDisplayName)}」として登録しようとしています。\n\n` +
    `このバインディングを承認すると、このチャネルから承認ワークフローでチケットを承認・却下できるようになります。\n\n` +
    `確認コード: \`${input.verificationCode}\`\n\n` +
    `_この確認は15分で期限切れになります。心当たりがない場合は「拒否」をクリックしてください。_`;

  const inlineKeyboard = [
    [
      { text: "✅ 承認者として登録する", callback_data: `vb:c:${callbackValue}` },
    ],
    [
      { text: "❌ 拒否する", callback_data: `vb:r:${callbackValue}` },
    ],
  ];

  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.telegramUserId,
        text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
      error_code?: number;
    };

    if (!body.ok) {
      console.error("telegram_verification_via_channel_dm_failed", {
        telegramUserId: input.telegramUserId,
        channelId: input.channelId,
        error: body.description,
        errorCode: body.error_code,
      });

      if (body.error_code === 403 || (body.description && body.description.includes("bot can't initiate"))) {
        return {
          ok: false,
          error: "bot_blocked_or_not_started",
          nextStepJa: `このチャネルのBotからDMを送信できません。ユーザー ${input.telegramUserId} がまだBotを開始していない可能性があります。Telegramでこのチャネル用のBotを /start してから再度お試しください。`,
        };
      }

      return { ok: false, error: body.description || "send_failed" };
    }

    return { ok: true, messageId: body.result?.message_id };
  } catch (error) {
    console.error("telegram_verification_via_channel_dm_error", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "network_error",
    };
  }
}

function escapeTelegramMarkdown(value: unknown): string {
  return String(value ?? "")
    .replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

export function buildTelegramVerificationCallbackValue(input: {
  orgId: string;
  telegramUserId: string;
  verificationCode: string;
  channelKey: string;
}): string {
  const payload = JSON.stringify({
    o: input.orgId,
    u: input.telegramUserId,
    v: input.verificationCode,
    c: input.channelKey,
    t: Date.now(),
  });
  const sig = createHmac("sha256", getCallbackSecret())
    .update(payload)
    .digest("base64url")
    .slice(0, 12);
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function parseTelegramVerificationCallbackValue(
  value: string
): { ok: true; orgId: string; telegramUserId: string; verificationCode: string; channelKey: string } | { ok: false; reason: string } {
  const parts = value.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid_format" };

  const [payloadB64, sig] = parts;
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString();
  } catch {
    return { ok: false, reason: "decode_failed" };
  }

  const expectedSig = createHmac("sha256", getCallbackSecret())
    .update(payload)
    .digest("base64url")
    .slice(0, 12);

  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_invalid" };
  }

  try {
    const parsed = JSON.parse(payload) as { o?: string; u?: string; v?: string; c?: string; t?: number };
    if (!parsed.o || !parsed.u || !parsed.v) {
      return { ok: false, reason: "missing_fields" };
    }
    return {
      ok: true,
      orgId: parsed.o,
      telegramUserId: parsed.u,
      verificationCode: parsed.v,
      channelKey: parsed.c || TELEGRAM_GLOBAL_CHANNEL_KEY,
    };
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
}

export async function handleTelegramVerificationConfirm(input: {
  callbackValue: string;
  presserTelegramUserId: string;
}): Promise<
  | { ok: true; binding: VoterBinding; messageJa: string }
  | { ok: false; reason: string; messageJa: string }
> {
  let parsed: ReturnType<typeof parseTelegramVerificationCallbackValue>;
  try {
    parsed = parseTelegramVerificationCallbackValue(input.callbackValue);
  } catch (error) {
    if (error instanceof Error && error.message.includes("VOTER_BINDING_SECRET")) {
      console.error("voter_binding_secret_not_configured", { error: error.message });
      return {
        ok: false,
        reason: "secret_not_configured",
        messageJa: "システム設定エラー: 検証シークレットが設定されていません。",
      };
    }
    throw error;
  }

  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      messageJa: "検証データが不正です。リンクが無効または改ざんされています。",
    };
  }

  if (parsed.telegramUserId !== input.presserTelegramUserId) {
    return {
      ok: false,
      reason: "user_mismatch",
      messageJa: "このボタンはあなた宛てではありません。",
    };
  }

  let result: Awaited<ReturnType<typeof verifyVoterBinding>>;
  try {
    result = await verifyVoterBinding({
      orgId: parsed.orgId,
      provider: "telegram" as VoterBindingProvider,
      channelKey: parsed.channelKey,
      externalUserId: parsed.telegramUserId,
      verificationCode: parsed.verificationCode,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("VOTER_BINDING_SECRET")) {
      console.error("voter_binding_secret_not_configured", { error: error.message });
      return {
        ok: false,
        reason: "secret_not_configured",
        messageJa: "システム設定エラー: 検証シークレットが設定されていません。",
      };
    }
    throw error;
  }

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    binding: result.binding,
    messageJa: "承認者として正常に登録されました。承認ワークフローでチケットを処理できます。",
  };
}

export async function handleTelegramVerificationReject(input: {
  callbackValue: string;
  presserTelegramUserId: string;
}): Promise<{ ok: true; messageJa: string } | { ok: false; reason: string; messageJa: string }> {
  let parsed: ReturnType<typeof parseTelegramVerificationCallbackValue>;
  try {
    parsed = parseTelegramVerificationCallbackValue(input.callbackValue);
  } catch (error) {
    if (error instanceof Error && error.message.includes("VOTER_BINDING_SECRET")) {
      return {
        ok: false,
        reason: "secret_not_configured",
        messageJa: "システム設定エラー",
      };
    }
    throw error;
  }

  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      messageJa: "検証データが不正です。",
    };
  }

  if (parsed.telegramUserId !== input.presserTelegramUserId) {
    return {
      ok: false,
      reason: "user_mismatch",
      messageJa: "このボタンはあなた宛てではありません。",
    };
  }

  return {
    ok: true,
    messageJa: "バインディングリクエストを拒否しました。",
  };
}

export interface SendTelegramVerificationToGroupInput {
  telegramUserId: string;
  orgId: string;
  memberId: string;
  memberDisplayName: string;
  orgName: string;
  verificationCode: string;
  channelId: string;
  botToken: string;
  groupChatId: string;
}

/**
 * Send verification message to a GROUP chat with user-restricted buttons.
 * Used as a fallback when DM sending fails (user hasn't started the bot).
 * The buttons are restricted to only the target user via callback data validation.
 */
export async function sendVerificationToTelegramGroup(
  input: SendTelegramVerificationToGroupInput
): Promise<TelegramVerificationViaChannelResult> {
  const botToken = input.botToken?.trim();
  if (!botToken || !input.telegramUserId?.trim() || !input.groupChatId?.trim()) {
    return { ok: false, error: "missing_credentials" };
  }

  const callbackValue = buildTelegramVerificationCallbackValue({
    orgId: input.orgId,
    telegramUserId: input.telegramUserId,
    verificationCode: input.verificationCode,
    channelKey: input.channelId,
  });

  const text = `*Staffpass 承認者登録の確認*\n\n` +
    `組織「${escapeTelegramMarkdown(input.orgName)}」で承認者「${escapeTelegramMarkdown(input.memberDisplayName)}」として登録しようとしています。\n\n` +
    `下のボタンは *承認者本人のみ* が押せます（他の人が押しても無効です）。\n\n` +
    `確認コード: \`${input.verificationCode}\`\n\n` +
    `_この確認は15分で期限切れになります。_`;

  const inlineKeyboard = [
    [
      { text: "✅ 承認者として登録する", callback_data: `vb:c:${callbackValue}` },
    ],
    [
      { text: "❌ 拒否する", callback_data: `vb:r:${callbackValue}` },
    ],
  ];

  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.groupChatId,
        text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
      error_code?: number;
    };

    if (!body.ok) {
      console.error("telegram_verification_group_send_failed", {
        telegramUserId: input.telegramUserId,
        channelId: input.channelId,
        groupChatId: input.groupChatId,
        error: body.description,
        errorCode: body.error_code,
      });
      return { ok: false, error: body.description || "send_failed" };
    }

    return { ok: true, messageId: body.result?.message_id };
  } catch (error) {
    console.error("telegram_verification_group_send_error", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "network_error",
    };
  }
}

export const TELEGRAM_GLOBAL_CHANNEL_KEY = "telegram:global";

export function isTelegramGlobalChannelKey(channelKey: string): boolean {
  return channelKey === TELEGRAM_GLOBAL_CHANNEL_KEY;
}
