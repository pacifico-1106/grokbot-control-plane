import { getEnabledConversationAdapter } from "@/lib/data/conversation-adapters";
import {
  getEnabledNotificationChannels,
  isSharedApprovalAppChannelConfig,
} from "@/lib/data/notification-channels";

const SLACK_TIMEOUT_MS = 5_000;

/** Fail-closed code when the only org Slack bot is the shared approval app (approval plane only). */
export const CONVERSATION_BOT_TOKEN_MISSING = "slack_conversation_bot_token_missing";

export type OrgSlackBotTokenResolution = {
  token: string;
  /** True when a shared approval app inbox with a bot token was skipped (it is never a conversation bot). */
  skippedSharedApprovalApp: boolean;
};

/**
 * Conversation-plane org bot token (xoxb): conversation adapter → per-tenant
 * Slack notify inbox. Only the org's OWN tokens are candidates:
 * - The shared approval app ("Staffpass承認", `config.sharedApprovalApp === true`)
 *   is NEVER a candidate: its xoxb belongs to the approval plane only
 *   (docs/slack-shared-approval-app.md). Approval-plane senders read their inbox
 *   secrets directly and are unaffected.
 * - The process-wide SLACK_BOT_TOKEN / SLACK_CONVERSATION_BOT_TOKEN env is NEVER
 *   a candidate (removed 2026-10-04): in multi-tenant production it is one
 *   workspace's bot and would post another tenant's messages through it.
 *   An org that needs a bot registers its own xoxb on the conversation adapter.
 */
export async function resolveOrgSlackBotTokenDetailed(orgId: string): Promise<OrgSlackBotTokenResolution> {
  const adapter = await getEnabledConversationAdapter(orgId, "slack");
  const adapterToken = adapter?.secrets.botToken?.trim() || "";
  if (adapterToken) return { token: adapterToken, skippedSharedApprovalApp: false };

  const slackChannels = (await getEnabledNotificationChannels(orgId)).filter(
    (channel) => channel.provider === "slack"
  );
  const skippedSharedApprovalApp = slackChannels.some(
    (channel) => isSharedApprovalAppChannelConfig(channel.config) && Boolean(channel.secrets.botToken?.trim())
  );
  const notifyToken =
    slackChannels
      .find((channel) => !isSharedApprovalAppChannelConfig(channel.config))
      ?.secrets.botToken?.trim() || "";
  if (notifyToken) return { token: notifyToken, skippedSharedApprovalApp };

  return { token: "", skippedSharedApprovalApp };
}

/** Conversation-plane org bot token (xoxb) only; never the shared approval app. "" when none. */
export async function resolveOrgSlackBotToken(orgId: string): Promise<string> {
  return (await resolveOrgSlackBotTokenDetailed(orgId)).token;
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
