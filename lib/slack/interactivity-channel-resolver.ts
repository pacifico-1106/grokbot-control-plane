/**
 * Bounded channel resolution for Slack interactivity endpoint.
 * P0 Item 3: Find notification channels by (api_app_id, team_id) without
 * iterating all orgs' secrets unbounded.
 *
 * Security:
 * - Only returns candidates matching the given api_app_id and team_id
 * - Never exposes signing secrets directly to callers (only for signature verification)
 * - Bounded search prevents timing attacks on secret enumeration
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { decryptNotificationSecrets } from "@/lib/notify/crypto";

export interface InteractivityChannelCandidate {
  id: string;
  orgId: string;
  apiAppId: string;
  teamId: string;
  expectedTeamId: string | null;
  signingSecret: string;
  botToken: string;
  allowedUserIds: string[];
  config: Record<string, unknown>;
}

type DemoChannel = {
  id: string;
  orgId: string;
  provider: "slack";
  config: {
    apiAppId?: string;
    teamId?: string;
    expectedTeamId?: string;
    allowedUserIds?: string[];
    channelId?: string;
  };
  secrets: {
    botToken?: string;
    signingSecret?: string;
  };
};

const demoChannels: DemoChannel[] = [];

export function setDemoInteractivityChannel(channel: DemoChannel): void {
  if (!isDemoMode()) throw new Error("demo_only");
  const idx = demoChannels.findIndex((c) => c.id === channel.id);
  if (idx >= 0) demoChannels[idx] = channel;
  else demoChannels.push(channel);
}

export function resetDemoInteractivityChannels(): void {
  demoChannels.length = 0;
}

export async function findChannelCandidatesByAppAndTeam(
  apiAppId: string,
  teamId: string
): Promise<InteractivityChannelCandidate[]> {
  if (!apiAppId?.trim() || !teamId?.trim()) {
    return [];
  }

  if (isDemoMode()) {
    return demoChannels
      .filter(
        (c) =>
          c.provider === "slack" &&
          (c.config.apiAppId === apiAppId || !c.config.apiAppId) &&
          (c.config.teamId === teamId ||
            c.config.expectedTeamId === teamId ||
            (!c.config.teamId && !c.config.expectedTeamId))
      )
      .map((c) => ({
        id: c.id,
        orgId: c.orgId,
        apiAppId: c.config.apiAppId || apiAppId,
        teamId: c.config.teamId || teamId,
        expectedTeamId: c.config.expectedTeamId || null,
        signingSecret: c.secrets.signingSecret || "",
        botToken: c.secrets.botToken || "",
        allowedUserIds: c.config.allowedUserIds || [],
        config: c.config,
      }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data: channelRows, error: channelError } = await admin
    .from("org_notification_channels")
    .select("id, org_id, config")
    .eq("provider", "slack")
    .eq("enabled", true)
    .or(`config->apiAppId.eq.${apiAppId},config->apiAppId.is.null`)
    .or(`config->teamId.eq.${teamId},config->expectedTeamId.eq.${teamId},config->teamId.is.null`);

  if (channelError || !channelRows || channelRows.length === 0) {
    return [];
  }

  const filtered = channelRows.filter((row) => {
    const config = (row.config as Record<string, unknown>) || {};
    const rowApiAppId = config.apiAppId as string | undefined;
    const rowTeamId = (config.teamId || config.expectedTeamId) as string | undefined;

    if (rowApiAppId && rowApiAppId !== apiAppId) return false;
    if (rowTeamId && rowTeamId !== teamId) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  const channelIds = filtered.map((row) => String(row.id));
  
  const { data: secretRows, error: secretError } = await admin
    .from("org_notification_channel_secrets")
    .select("channel_id, credentials_ciphertext")
    .in("channel_id", channelIds);

  if (secretError || !secretRows) {
    return [];
  }

  const secretMap = new Map(
    secretRows.map((row) => [
      String(row.channel_id),
      String(row.credentials_ciphertext || ""),
    ])
  );

  const candidates: InteractivityChannelCandidate[] = [];
  for (const row of filtered) {
    const ciphertext = secretMap.get(String(row.id));
    if (!ciphertext) continue;

    let secrets: { botToken?: string; signingSecret?: string };
    try {
      secrets = decryptNotificationSecrets(ciphertext);
    } catch {
      continue;
    }

    const config = (row.config as Record<string, unknown>) || {};
    candidates.push({
      id: String(row.id),
      orgId: String(row.org_id),
      apiAppId: (config.apiAppId as string) || apiAppId,
      teamId: (config.teamId as string) || teamId,
      expectedTeamId: (config.expectedTeamId as string) || null,
      signingSecret: secrets.signingSecret || "",
      botToken: secrets.botToken || "",
      allowedUserIds: Array.isArray(config.allowedUserIds)
        ? (config.allowedUserIds as string[])
        : [],
      config,
    });
  }

  return candidates;
}

export async function findChannelByDeliveryContext(
  apiAppId: string,
  teamId: string,
  slackChannelId: string,
  messageTs: string
): Promise<InteractivityChannelCandidate | null> {
  const candidates = await findChannelCandidatesByAppAndTeam(apiAppId, teamId);
  
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (isDemoMode()) {
    return candidates[0];
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return candidates[0];

  const { data: deliveries, error } = await admin
    .from("approval_notification_deliveries")
    .select("channel_id")
    .in(
      "channel_id",
      candidates.map((c) => c.id)
    )
    .eq("external_message_id", messageTs)
    .limit(1);

  if (error || !deliveries || deliveries.length === 0) {
    return candidates[0];
  }

  const matchedChannelId = String(deliveries[0].channel_id);
  return candidates.find((c) => c.id === matchedChannelId) ?? candidates[0];
}
