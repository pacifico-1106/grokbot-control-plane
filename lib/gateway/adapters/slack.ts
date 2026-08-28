import { getEnabledConversationAdapter } from "@/lib/data/conversation-adapters";
import { getEnabledNotificationChannels } from "@/lib/data/notification-channels";

const SLACK_TIMEOUT_MS = 5_000;

export type SlackConversationPostResult =
  | { ok: true; delivery: "stub" }
  | { ok: true; delivery: "slack"; channel: string; ts: string }
  | { ok: false; error: string };

export function looksLikeSlackTs(value: string | undefined | null): boolean {
  return Boolean(value && /^\d+\.\d+$/.test(value.trim()));
}

async function resolveConversationBotToken(orgId: string): Promise<string> {
  const adapter = await getEnabledConversationAdapter(orgId, "slack");
  const adapterToken = adapter?.secrets.botToken?.trim() || "";
  if (adapterToken) return adapterToken;

  // Conversation adapter is still the preferred store; fallback unblocks live
  // mention-reply when only notify Slack is configured. Do NOT post approval
  // tickets through this path.
  const notifyChannels = await getEnabledNotificationChannels(orgId);
  const notifyToken =
    notifyChannels
      .find((channel) => channel.provider === "slack")
      ?.secrets.botToken?.trim() || "";
  if (notifyToken) return notifyToken;

  return (
    process.env.SLACK_BOT_TOKEN?.trim() ||
    process.env.SLACK_CONVERSATION_BOT_TOKEN?.trim() ||
    ""
  );
}

export async function postConversationMessage(input: {
  orgId: string;
  channel: string;
  text: string;
  threadTs?: string;
  summarize?: boolean;
}): Promise<SlackConversationPostResult> {
  const dest = input.channel.trim();
  if (!dest) return { ok: false, error: "slack_channel_required" };
  const token = await resolveConversationBotToken(input.orgId);
  if (!token) return { ok: true, delivery: "stub" };

  const text = input.summarize
    ? `【要約のみ】\n${input.text || ""}`
    : input.text || "";
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: dest,
        text,
        ...(looksLikeSlackTs(input.threadTs) ? { thread_ts: input.threadTs } : {}),
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      channel?: string;
      ts?: string;
    };
    if (!body.ok) {
      return { ok: false, error: body.error || `slack_http_${response.status}` };
    }
    if (!body.channel || !body.ts) {
      return { ok: false, error: "slack_message_missing" };
    }
    return { ok: true, delivery: "slack", channel: body.channel, ts: body.ts };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "slack_fetch_failed",
    };
  }
}
