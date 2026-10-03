import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { updateApprovalTelegramState } from "@/lib/data/approvals";
import {
  getNotificationDelivery,
  recordNotificationDelivery,
  type NotificationChannelRuntime,
} from "@/lib/data/notification-channels";
import type { ApprovalRequest, Employee } from "@/lib/types";

const LINE_TIMEOUT_MS = 5_000;

export type LineResult = { ok: boolean; skipped?: boolean; error?: string };

function target(channel: NotificationChannelRuntime) {
  const accessToken = channel.secrets.channelAccessToken?.trim() || "";
  const channelSecret = channel.secrets.channelSecret?.trim() || "";
  const destinationId = String(channel.config.destinationId || "").trim();
  const allowedUserIds = Array.isArray(channel.config.allowedUserIds)
    ? channel.config.allowedUserIds.map(String)
    : [];
  return { accessToken, channelSecret, destinationId, allowedUserIds };
}

async function callLine(
  channel: NotificationChannelRuntime,
  path: string,
  payload: Record<string, unknown>
): Promise<LineResult> {
  const { accessToken } = target(channel);
  if (!accessToken) return { ok: false, error: "line_access_token_missing" };
  try {
    const response = await fetch(`https://api.line.me${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: `line_http_${response.status}:${body.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "line_fetch_failed" };
  }
}

function truncate(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

export function verifyLineSignature(
  channel: NotificationChannelRuntime,
  rawBody: string,
  signature: string
): boolean {
  const secret = target(channel).channelSecret;
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAllowedLineSource(
  channel: NotificationChannelRuntime,
  source: { userId?: string; groupId?: string; roomId?: string }
): boolean {
  const cfg = target(channel);
  const destination = source.groupId || source.roomId || source.userId || "";
  if (!destination || destination !== cfg.destinationId) return false;
  return cfg.allowedUserIds.length === 0 || Boolean(source.userId && cfg.allowedUserIds.includes(source.userId));
}

export async function sendApprovalToLineChannel(
  approval: ApprovalRequest,
  employee: Employee | null,
  channel: NotificationChannelRuntime
): Promise<LineResult> {
  const cfg = target(channel);
  if (!cfg.destinationId || !approval.telegramRef) return { ok: false, skipped: true };
  const altText = `承認依頼: ${approval.title}`;
  const result = await callLine(channel, "/v2/bot/message/push", {
    to: cfg.destinationId,
    messages: [{
      type: "flex",
      altText: truncate(altText, 400),
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            { type: "text", text: "🟡 承認依頼", weight: "bold", size: "lg" },
            { type: "text", text: truncate(approval.title, 120), wrap: true, weight: "bold" },
            { type: "text", text: `社員: ${employee?.displayName || approval.employeeId}`, size: "sm", wrap: true },
            { type: "text", text: `ツール: ${approval.tool || "unknown"}`, size: "sm", wrap: true },
            { type: "text", text: `目的: ${approval.purpose}`, size: "sm", wrap: true },
            { type: "text", text: truncate(approval.summary, 500), size: "sm", color: "#666666", wrap: true },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            { type: "button", style: "primary", action: { type: "postback", label: "承認", data: `a:${approval.telegramRef}`, displayText: "承認" } },
            { type: "button", action: { type: "postback", label: "却下", data: `r:${approval.telegramRef}`, displayText: "却下" } },
            { type: "button", action: { type: "postback", label: "修正依頼", data: `e:${approval.telegramRef}`, displayText: "修正依頼" } },
          ],
        },
      },
    }],
  });
  if (result.ok) {
    await recordNotificationDelivery({ approval, channelId: channel.id, provider: "line" });
  }
  return result;
}

export async function sendLineText(
  channel: NotificationChannelRuntime,
  text: string,
  replyToken?: string
): Promise<LineResult> {
  if (replyToken) {
    return callLine(channel, "/v2/bot/message/reply", {
      replyToken,
      messages: [{ type: "text", text: truncate(text, 5_000) }],
    });
  }
  const destinationId = target(channel).destinationId;
  if (!destinationId) return { ok: false, skipped: true };
  return callLine(channel, "/v2/bot/message/push", {
    to: destinationId,
    messages: [{ type: "text", text: truncate(text, 5_000) }],
  });
}

/**
 * G7: per-request collector so the resolve follow-up ("✅ 承認済み …") can ride
 * in the webhook's Reply (free) instead of a separate Push (billable).
 * Only the webhook opens a collector, only for its own channel, and only when
 * LINE_RESOLVE_FOLLOWUP_REPLY is ON. Anything sent after the collector closes,
 * or for another channel, keeps using Push.
 */
type LineReplyCollector = { channelId: string; texts: string[]; closed: boolean };
const replyCollector = new AsyncLocalStorage<LineReplyCollector>();
const LINE_REPLY_MAX_MESSAGES = 5;

export async function withLineReplyCollector<T>(
  channelId: string,
  fn: () => Promise<T>
): Promise<{ result: T; collected: string[] }> {
  const store: LineReplyCollector = { channelId, texts: [], closed: false };
  try {
    const result = await replyCollector.run(store, fn);
    return { result, collected: [...store.texts] };
  } finally {
    store.closed = true;
  }
}

function collectForReply(channel: NotificationChannelRuntime, text: string): boolean {
  const store = replyCollector.getStore();
  if (!store || store.closed || store.channelId !== channel.id) return false;
  // Leave room for the acknowledgement message in the same Reply.
  if (store.texts.length >= LINE_REPLY_MAX_MESSAGES - 1) return false;
  store.texts.push(text);
  return true;
}

export async function sendLineReplyMessages(
  channel: NotificationChannelRuntime,
  replyToken: string,
  texts: string[]
): Promise<LineResult> {
  const messages = texts
    .filter((text) => text && text.trim())
    .slice(0, LINE_REPLY_MAX_MESSAGES)
    .map((text) => ({ type: "text", text: truncate(text, 5_000) }));
  if (!replyToken || messages.length === 0) return { ok: false, skipped: true };
  return callLine(channel, "/v2/bot/message/reply", { replyToken, messages });
}

export async function resolveLineApprovalMessage(
  approval: ApprovalRequest,
  decision: "approved" | "rejected" | "revision_requested",
  actor: string,
  channel: NotificationChannelRuntime
): Promise<LineResult> {
  const delivery = await getNotificationDelivery({ approvalId: approval.id, channelId: channel.id });
  if (!delivery) return { ok: false, skipped: true };
  const label = decision === "approved" ? "✅ 承認済み" : decision === "rejected" ? "❌ 却下済み" : "✏️ 修正依頼済み";
  const text = `${label}\n${approval.title}${approval.revisionNote ? `\n指示: ${approval.revisionNote}` : ""}\n処理者: ${actor}`;
  if (collectForReply(channel, text)) return { ok: true };
  return sendLineText(channel, text);
}

export async function promptLineRevision(
  approval: ApprovalRequest,
  userId: string,
  replyToken: string,
  channel: NotificationChannelRuntime
): Promise<LineResult> {
  const updated = await updateApprovalTelegramState(approval, {
    awaitingRevisionFrom: userId,
    awaitingRevisionChannelId: channel.id,
    awaitingRevisionProvider: "line",
  });
  if (!updated) return { ok: false, error: "revision_state_update_failed" };
  return sendLineText(channel, "✏️ 修正指示をこのトークへテキストで送ってください。", replyToken);
}
