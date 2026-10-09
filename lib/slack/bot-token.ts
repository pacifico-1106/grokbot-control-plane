import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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

/** How long a VERIFIED users.info team id may be reused across invokes. */
export const SLACK_USER_TEAM_CACHE_TTL_MS = 60_000;
const SLACK_USER_TEAM_CACHE_MAX = 5_000;

/**
 * Cross-invoke cache: ONLY verified (non-null) team ids are stored, keyed by
 * (orgId, bot-token fingerprint, slackUserId) so one org's answer can never
 * serve another org and a token switch invalidates earlier answers at once.
 * Unverifiable results (no token, Slack error, timeout) are never cached here,
 * so they cannot outlive the invoke that saw them, and they stay "external".
 */
const verifiedTeamCache = new Map<string, { teamId: string; expiresAt: number }>();

/**
 * Per-invoke memo: one users.info per (org, user) per invoke, including a null
 * (unverifiable) result, which is reused only inside that same invoke.
 */
const invokeMemo = new AsyncLocalStorage<Map<string, Promise<string | null>>>();

/**
 * Short, non-reversible bot-token fingerprint (first 12 hex chars of sha256).
 * A token switch (reinstall, other workspace) changes the key, so earlier answers
 * stop being served immediately. The raw token never enters a key or a log line.
 */
function botTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function slackUserTeamKey(orgId: string, tokenFingerprint: string, slackUserId: string): string {
  return JSON.stringify([orgId, tokenFingerprint, slackUserId.toUpperCase()]);
}

/** Run fn with a fresh per-invoke users.info memo (nested scopes reuse the outer one). */
export function withSlackUserTeamMemo<T>(fn: () => Promise<T>): Promise<T> {
  if (invokeMemo.getStore()) return fn();
  return invokeMemo.run(new Map(), fn);
}

export function resetSlackUserTeamCacheForTests(): void {
  verifiedTeamCache.clear();
}

export function slackUserTeamCacheKeysForTests(): string[] {
  return [...verifiedTeamCache.keys()];
}

/**
 * The Slack team a user actually belongs to, as reported by Slack itself
 * (users.info with the org's OWN conversation bot token). Used instead of any
 * AI-supplied slackTeamId / speakerTeamId. null = could not verify (no token,
 * missing users:read, Slack error, timeout); callers treat that as NOT internal.
 */
export async function fetchVerifiedSlackUserTeamId(
  orgId: string,
  slackUserId: string
): Promise<string | null> {
  const user = slackUserId.trim();
  if (!orgId || !user) return null;
  const token = await resolveOrgSlackBotToken(orgId);
  if (!token) return null;
  const key = slackUserTeamKey(orgId, botTokenFingerprint(token), user);
  const now = Date.now();
  const cached = verifiedTeamCache.get(key);
  if (cached) {
    if (cached.expiresAt > now) return cached.teamId;
    verifiedTeamCache.delete(key);
  }
  const memo = invokeMemo.getStore();
  const pending = memo?.get(key);
  if (pending) return pending;
  const lookup = fetchSlackUserTeamIdUncached(token, user).then((teamId) => {
    if (teamId) {
      if (verifiedTeamCache.size >= SLACK_USER_TEAM_CACHE_MAX) {
        const oldest = verifiedTeamCache.keys().next().value;
        if (oldest !== undefined) verifiedTeamCache.delete(oldest);
      }
      verifiedTeamCache.set(key, { teamId, expiresAt: Date.now() + SLACK_USER_TEAM_CACHE_TTL_MS });
    }
    return teamId;
  });
  memo?.set(key, lookup);
  return lookup;
}

async function fetchSlackUserTeamIdUncached(token: string, user: string): Promise<string | null> {
  try {
    const url = `https://slack.com/api/users.info?user=${encodeURIComponent(user)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      user?: { id?: string; team_id?: string; deleted?: boolean };
    };
    if (!body.ok || !body.user || body.user.deleted) return null;
    if (body.user.id && body.user.id.toUpperCase() !== user.toUpperCase()) return null;
    const team = typeof body.user.team_id === "string" ? body.user.team_id.trim().toUpperCase() : "";
    return team || null;
  } catch {
    return null;
  }
}
