/**
 * P0 User-token channel mention ingress — flag-gated scaffold.
 *
 * This module provides User-originated path for channel mentions in external
 * Slack Connect channels where the partner workspace does NOT have Staffpass
 * app installed. The AI employee's user token receives message.channels/groups
 * events and wakes the employee on explicit @mention.
 *
 * @see docs/p0-user-mention-ingress-design-20260919.md
 *
 * DESIGN LOCKS (non-negotiable):
 * - DL-1: No standing god-token. No history batch crawl.
 * - DL-2: Explicit identity map only. No fuzzy match. Fail-closed.
 * - DL-3: Audit: token subject / channel / employee / event / wake outcome
 * - DL-4: Connect: explicit team_id handling for guest vs home identity
 * - DL-5: Revoke / re-OAuth / offboarding flows (separate implementation)
 * - DL-6: G7 Bot path = fallback only. User ingress =正規 external mouth
 *
 * Slack App Config Requirements (ops):
 * - User Token Scopes: channels:history, groups:history (+ existing im:history, chat:write, users:read)
 * - Subscribe to events on behalf of users: message.channels, message.groups
 * - After Slack app scope update, affected employees must re-OAuth to acquire new scopes
 *
 * @module
 */

import type { ChannelClassification } from "@/lib/types";

/**
 * Feature flag for P0 user-token channel mention ingress.
 * Default OFF — code paths using this are dead until explicitly enabled.
 *
 * When OFF:
 * - User-token channel events (message.channels, message.groups) are silently skipped
 * - Existing Bot mention ingress / G7 paths unchanged
 * - No production behavior change
 *
 * When ON:
 * - User-token channel events are processed for eligible @mentions
 * - Explicit identity map resolution (DL-2)
 * - Fail-closed on unbound/unclassified/cross-tenant
 * - Audit stubs for all wake/skip outcomes (DL-3)
 *
 * Enable via: P0_USER_CHANNEL_MENTION_INGRESS=1
 */
export function isUserChannelMentionIngressEnabled(): boolean {
  return process.env.P0_USER_CHANNEL_MENTION_INGRESS === "1";
}

/**
 * Slack envelope authorization for user-token events.
 * User-token events have authorizations[].is_bot = false.
 */
export interface UserTokenAuthorization {
  userId: string;
  teamId: string;
}

/**
 * Context extracted from a user-token channel event for wake resolution.
 * Used for explicit identity map matching (DL-2) and audit (DL-3).
 */
export interface UserChannelEventContext {
  valid: boolean;
  reason?: string;
  eventId: string;
  eventType: "message.channels" | "message.groups";
  channelId: string;
  speakerId: string;
  speakerTeamId: string;
  subscriberUserId: string;
  subscriberTeamId: string;
  mentionedUserIds: string[];
  text: string;
  ts: string;
  threadTs: string | null;
  isConnect: boolean;
}

/**
 * Audit fields for user-token channel wake/skip events (DL-3).
 * Required fields from design §5.
 */
export interface UserChannelWakeAudit {
  tokenSubject: {
    slackUserId: string;
    slackTeamId: string;
  };
  channel: {
    channelId: string;
    channelClassification: ChannelClassification;
    isShared: boolean;
  };
  employee: {
    employeeId: string;
    orgId: string;
  };
  event: {
    eventId: string;
    eventType: string;
    speakerId: string;
    speakerTeamId: string;
    mentionedIds: string[];
    timestamp: string;
  };
  outcome: {
    woke: boolean;
    skipReason?: string;
    webhookStatus?: number;
  };
}

/**
 * Skip reasons for user-token channel events (DL-2 fail-closed).
 * Each skip is auditable per DL-3.
 */
export type UserChannelSkipReason =
  | "flag_off"
  | "employee_not_bound"
  | "channel_not_classified"
  | "team_mismatch"
  | "no_mention"
  | "self_loop"
  | "auth_mismatch"
  | "invalid_event";

/**
 * Check if a channel ID looks like a Slack DM (D-prefixed).
 * Matches existing isSlackImChannelId pattern from slack-im-routes.ts.
 */
function looksLikeImChannel(channelId: string): boolean {
  return /^D[A-Z0-9]+$/i.test((channelId || "").trim());
}

/**
 * Check if an event is a user-token channel event (message.channels or message.groups).
 * Bot events have channel_type and go through existing app_mention / message.im paths.
 *
 * User-token channel events are identified by:
 * 1. Event type is "message" (not "app_mention")
 * 2. authorizations[].is_bot = false (user token, not bot token)
 * 3. Channel is not a DM:
 *    - channel_type !== "im"
 *    - Channel ID does not start with "D" (D-prefixed = DM channel)
 *
 * This ensures D-prefixed channels (DMs) are routed to existing Path B (user-token IM),
 * even when Slack omits channel_type in the event payload.
 */
export function isUserTokenChannelEvent(envelope: {
  event?: { type?: string; channel_type?: string; channel?: string };
  authorizations?: Array<{ is_bot?: boolean; user_id?: string; team_id?: string }>;
}): boolean {
  const event = envelope.event;
  if (!event) return false;

  const eventType = event.type;
  const channelType = event.channel_type;
  const channelId = event.channel || "";

  if (eventType !== "message") return false;
  if (channelType === "im") return false;
  if (looksLikeImChannel(channelId)) return false;

  const auths = envelope.authorizations;
  if (!auths || !Array.isArray(auths)) return false;

  for (const auth of auths) {
    if (auth && auth.is_bot === false && auth.user_id) {
      return true;
    }
  }

  return false;
}

/**
 * Extract user-token authorization from envelope.
 * Returns null for bot-token events or missing authorizations.
 */
export function extractUserTokenAuth(envelope: {
  authorizations?: Array<{ is_bot?: boolean; user_id?: string; team_id?: string }>;
}): UserTokenAuthorization | null {
  const auths = envelope.authorizations;
  if (!auths || !Array.isArray(auths)) return null;

  for (const auth of auths) {
    if (auth && auth.is_bot === false && auth.user_id && auth.team_id) {
      return {
        userId: auth.user_id,
        teamId: auth.team_id,
      };
    }
  }

  return null;
}

/**
 * Determine if event is from a Slack Connect shared channel.
 * Connect events have different speaker team_id vs subscriber team_id.
 * Per DL-4: explicit handling required.
 */
export function isConnectEvent(
  speakerTeamId: string,
  subscriberTeamId: string
): boolean {
  if (!speakerTeamId || !subscriberTeamId) return false;
  return speakerTeamId.toUpperCase() !== subscriberTeamId.toUpperCase();
}

/**
 * Check if the mention is a self-loop (speaker is the subscribed employee).
 * Per DL-2: own-loop should skip (reuse patterns from mention-ingress.ts).
 */
export function isSelfLoop(speakerId: string, subscriberId: string): boolean {
  if (!speakerId || !subscriberId) return false;
  return speakerId.toUpperCase() === subscriberId.toUpperCase();
}

/**
 * Build audit payload for user-token channel wake/skip.
 * Required fields per design §5 (DL-3).
 */
export function buildUserChannelWakeAudit(params: {
  tokenSubject: { slackUserId: string; slackTeamId: string };
  channelId: string;
  channelClassification: ChannelClassification;
  isShared: boolean;
  employeeId: string;
  orgId: string;
  eventId: string;
  eventType: string;
  speakerId: string;
  speakerTeamId: string;
  mentionedIds: string[];
  timestamp: string;
  woke: boolean;
  skipReason?: UserChannelSkipReason;
  webhookStatus?: number;
}): UserChannelWakeAudit {
  return {
    tokenSubject: {
      slackUserId: params.tokenSubject.slackUserId,
      slackTeamId: params.tokenSubject.slackTeamId,
    },
    channel: {
      channelId: params.channelId,
      channelClassification: params.channelClassification,
      isShared: params.isShared,
    },
    employee: {
      employeeId: params.employeeId,
      orgId: params.orgId,
    },
    event: {
      eventId: params.eventId,
      eventType: params.eventType,
      speakerId: params.speakerId,
      speakerTeamId: params.speakerTeamId,
      mentionedIds: params.mentionedIds,
      timestamp: params.timestamp,
    },
    outcome: {
      woke: params.woke,
      skipReason: params.skipReason,
      webhookStatus: params.webhookStatus,
    },
  };
}
