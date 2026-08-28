import { getEnabledConversationAdapter } from "@/lib/data/conversation-adapters";
import { getEnabledNotificationChannels } from "@/lib/data/notification-channels";

const SLACK_TIMEOUT_MS = 5_000;

/** Org bot token (xoxb) only. Notify / SLACK_BOT_TOKEN fallback stays on this path. */
export async function resolveOrgSlackBotToken(orgId: string): Promise<string> {
  const adapter = await getEnabledConversationAdapter(orgId, "slack");
  const adapterToken = adapter?.secrets.botToken?.trim() || "";
  if (adapterToken) return adapterToken;

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

/**
 * conversations.info: true = Connect / ext-shared, false = not, null = could not see.
 * Fail-open to ledger when the bot token is missing or Slack is unreachable.
 */
export async function inspectSlackChannelExtShared(
  orgId: string,
  channelId: string
): Promise<boolean | null> {
  const dest = channelId.trim();
  if (!orgId || !dest) return null;
  const token = await resolveOrgSlackBotToken(orgId);
  if (!token) return null;
  try {
    const url = `https://slack.com/api/conversations.info?channel=${encodeURIComponent(dest)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      channel?: { is_ext_shared?: boolean; is_ext_shared_plus?: boolean };
    };
    if (!body.ok || !body.channel) return null;
    return Boolean(body.channel.is_ext_shared || body.channel.is_ext_shared_plus);
  } catch {
    return null;
  }
}
