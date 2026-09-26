/**
 * Slack channel validation for approval inbox registration.
 *
 * P0 Item 5: Reject Slack Connect / externally shared channels.
 * External channels pose cross-org leakage risks for approval workflows.
 */

const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 5_000;

type ConversationsInfoResponse = {
  ok?: boolean;
  error?: string;
  channel?: {
    id?: string;
    name?: string;
    is_channel?: boolean;
    is_private?: boolean;
    is_shared?: boolean;
    is_ext_shared?: boolean;
    is_org_shared?: boolean;
    is_pending_ext_shared?: boolean;
  };
};

export type ChannelValidationResult =
  | { ok: true; channelId: string; name: string }
  | { ok: false; code: string; reason: string };

/**
 * Check if a Slack channel is externally shared (Slack Connect / external).
 *
 * Fails closed:
 * - If the API call fails, returns error (fail-closed)
 * - If channel is is_ext_shared or is_shared, returns rejection
 * - If channel is is_pending_ext_shared, returns rejection
 *
 * @param botToken Slack bot token
 * @param channelId Slack channel ID
 */
export async function validateSlackChannelNotExternal(
  botToken: string,
  channelId: string
): Promise<ChannelValidationResult> {
  if (!botToken?.trim() || !channelId?.trim()) {
    return {
      ok: false,
      code: "missing_credentials",
      reason: "Bot token and channel ID are required",
    };
  }

  try {
    const response = await fetch(`${SLACK_API}/conversations.info?channel=${encodeURIComponent(channelId)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${botToken}`,
      },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({}))) as ConversationsInfoResponse;

    if (!body.ok) {
      return {
        ok: false,
        code: "slack_api_error",
        reason: body.error || `HTTP ${response.status}`,
      };
    }

    const channel = body.channel;
    if (!channel) {
      return {
        ok: false,
        code: "channel_not_found",
        reason: "Channel not found in response",
      };
    }

    if (channel.is_ext_shared) {
      return {
        ok: false,
        code: "slack_connect_channel",
        reason: "Slack Connect channels (is_ext_shared) are not allowed for approval inbox",
      };
    }

    if (channel.is_shared) {
      return {
        ok: false,
        code: "shared_channel",
        reason: "Externally shared channels are not allowed for approval inbox",
      };
    }

    if (channel.is_pending_ext_shared) {
      return {
        ok: false,
        code: "pending_external_share",
        reason: "Channels with pending external share are not allowed for approval inbox",
      };
    }

    return {
      ok: true,
      channelId: channel.id || channelId,
      name: channel.name || "",
    };
  } catch (error) {
    return {
      ok: false,
      code: "validation_failed",
      reason: error instanceof Error ? error.message : "Failed to validate channel",
    };
  }
}

/**
 * Check if a Slack user's team_id matches the expected workspace.
 *
 * Slack Connect users have a different team_id than the channel's workspace.
 * When SLACK_APPROVAL_STRICT is ON, reject external-org users.
 */
export function isSlackUserFromExpectedTeam(
  userTeamId: string | undefined,
  expectedTeamId: string | undefined
): { allowed: boolean; reason: string } {
  if (!expectedTeamId) {
    return { allowed: true, reason: "no_team_check_configured" };
  }

  if (!userTeamId) {
    return {
      allowed: false,
      reason: "user_team_id_missing",
    };
  }

  if (userTeamId !== expectedTeamId) {
    return {
      allowed: false,
      reason: "external_team_user",
    };
  }

  return { allowed: true, reason: "same_team" };
}
