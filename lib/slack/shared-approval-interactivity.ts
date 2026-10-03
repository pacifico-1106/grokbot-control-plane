/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED: resolve a Slack interactivity request that
 * names the shared approval app (api_app_id = SLACK_SHARED_APPROVAL_APP_ID).
 *
 * Order (fail-closed):
 *   1. verify the signature with the SHARED signing secret (env) — nothing else
 *      is consulted before this passes;
 *   2. team_id (now signed) → the single enabled shared-app inbox for that team
 *      (DB unique index guarantees ≤ 1 org per workspace); 0 or >1 → reject;
 *   3. the caller then runs the normal block_actions checks, every lookup
 *      scoped to THAT inbox's org + delivery (an approval of another org, or a
 *      card not delivered through this inbox, is never resolved).
 * Per-tenant approval apps never reach this path, and a shared-app request is
 * never verified with a per-tenant secret (shared inboxes store none).
 */
import { findSharedApprovalChannelsByTeam } from "@/lib/data/notification-channels";
import { verifySlackSignature } from "@/lib/notify/slack";
import { sharedApprovalAppConfig } from "@/lib/slack/shared-approval-app";
import type { InteractivityChannelCandidate } from "@/lib/slack/interactivity-channel-resolver";

export type SharedInteractivityResolution =
  | { ok: true; channel: InteractivityChannelCandidate }
  | { ok: false; status: 401 | 403; error: string };

export async function resolveSharedApprovalInteractivity(input: {
  apiAppId: string;
  teamId: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): Promise<SharedInteractivityResolution> {
  const config = sharedApprovalAppConfig();
  if (!config || input.apiAppId !== config.appId) return { ok: false, status: 401, error: "unauthorized" };
  const verified = verifySlackSignature({
    signingSecret: config.signingSecret,
    timestamp: input.timestamp,
    rawBody: input.rawBody,
    signature: input.signature,
  });
  if (!verified) return { ok: false, status: 401, error: "unauthorized" };
  const inboxes = await findSharedApprovalChannelsByTeam({ appId: config.appId, teamId: input.teamId, enabledOnly: true });
  if (inboxes.length === 0) return { ok: false, status: 403, error: "unknown_team" };
  if (inboxes.length > 1) {
    console.error("slack_shared_approval_ambiguous_team", { inboxIds: inboxes.map((row) => row.id) });
    return { ok: false, status: 403, error: "ambiguous_team" };
  }
  const inbox = inboxes[0];
  return {
    ok: true,
    channel: {
      id: inbox.id,
      orgId: inbox.orgId,
      apiAppId: config.appId,
      teamId: input.teamId,
      expectedTeamId: String(inbox.config.expectedTeamId || inbox.config.teamId || input.teamId),
      signingSecret: "",
      botToken: String(inbox.secrets.botToken || ""),
      allowedUserIds: Array.isArray(inbox.config.allowedUserIds) ? inbox.config.allowedUserIds.map(String) : [],
      config: inbox.config,
    },
  };
}

/**
 * Flag OFF (review M1): a signed press on an old shared-app card. Only after the
 * shared signing secret verifies does it resolve team → org and raise a #236
 * button alert (throttled). Forged / unknown-team presses raise nothing.
 */
export async function reportSharedApprovalPressWhileDisabled(input: {
  apiAppId: string;
  teamId: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): Promise<{ alerted: boolean }> {
  try {
    const config = sharedApprovalAppConfig();
    if (!config || input.apiAppId !== config.appId) return { alerted: false };
    const verified = verifySlackSignature({
      signingSecret: config.signingSecret,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
      signature: input.signature,
    });
    if (!verified) return { alerted: false };
    const inboxes = await findSharedApprovalChannelsByTeam({ appId: config.appId, teamId: input.teamId, enabledOnly: true });
    if (inboxes.length !== 1) return { alerted: false };
    const { alertApprovalDeliveryFailure } = await import("@/lib/notify/delivery-failure-alert");
    await alertApprovalDeliveryFailure({
      orgId: inboxes[0].orgId,
      kind: "button_failed",
      approvalId: null,
      provider: "slack",
      channelId: inboxes[0].id,
      reason: "shared_approval_app_disabled",
    });
    return { alerted: true };
  } catch {
    return { alerted: false };
  }
}
