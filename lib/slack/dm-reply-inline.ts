/**
 * SLACK_DM_REPLY_INLINE_ENABLED (default OFF) — G4 (2026-10-04).
 * Kept out of lib/feature-flags.ts on purpose (other open stacks touch it).
 *
 * When ON: a conversation reply (comm.reply / slack.post …) into a Slack DM is
 * posted to the DM's main flow — reply_policy `prefer_thread` (and the wake
 * parent stash) do NOT add a thread_ts there. A message that is already inside
 * a thread (thread_ts ≠ ts) is still answered in that thread.
 * Channels (C… / G…) are never affected.
 *
 * When OFF (default): behavior identical to main.
 */
import { resolveConversationThreadId } from "@/lib/gateway/audience";
import { isSlackChannelId, isSlackDmChannel, looksLikeSlackTs } from "@/lib/gateway/adapters/slack";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isSlackDmReplyInlineEnabled(): boolean {
  return parseFlag(process.env.SLACK_DM_REPLY_INLINE_ENABLED);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function claimsIm(...sources: unknown[]): boolean {
  return sources.some((source) => {
    const row = record(source);
    return [row.channel_type, row.channelType].some(
      (value) => typeof value === "string" && value.trim().toLowerCase() === "im"
    );
  });
}

/**
 * DM = the destination is a D… channel (existing isSlackDmChannel), or the
 * wake / client says channel_type "im" for a destination that is not a C/G
 * channel. A C/G id is never treated as a DM, whatever the client claims.
 */
export function isSlackDmReplyTarget(input: {
  channelId?: string | null;
  conversation?: unknown;
  args?: unknown;
}): boolean {
  const dest = (input.channelId || "").trim();
  if (!dest) return false;
  if (isSlackChannelId(dest)) return false;
  if (isSlackDmChannel(dest)) return true;
  return claimsIm(input.conversation, input.args);
}

/**
 * Thread for a DM reply when the flag is ON: only a real thread parent that
 * differs from the received message ts (= the message is inside a thread).
 * thread_ts == ts, the messageTs fallback, or no thread → main flow.
 */
export function resolveSlackDmInlineThreadTs(input: {
  conversation?: unknown;
  args?: Record<string, unknown> | null;
  body?: { threadId?: string } | null;
}): { threadTs: string | undefined; source: "client" | "none" } {
  const conversation = record(input.conversation);
  const args = record(input.args);
  const threadTs = resolveConversationThreadId({ conversation, args, body: input.body ?? null });
  if (!looksLikeSlackTs(threadTs)) return { threadTs: undefined, source: "none" };
  // The received message's own ts (any alias). resolveConversationThreadId falls
  // back to messageTs/slackTs, so a match means "not inside a thread".
  const messageTsValues = [conversation.ts, conversation.messageTs, conversation.slackTs, args.ts, args.messageTs, args.slackTs]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim());
  if (messageTsValues.includes(String(threadTs).trim())) return { threadTs: undefined, source: "none" };
  return { threadTs, source: "client" };
}
