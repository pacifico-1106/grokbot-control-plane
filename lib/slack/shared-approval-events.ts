/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED: Event Subscriptions of the shared approval
 * app (Request URL /api/webhooks/slack/approval-app/events). Bot events:
 * app_uninstalled, tokens_revoked only.
 *
 * 1. Signature + timestamp (±5 min) verified with the SHARED signing secret
 *    before anything else (url_verification included).
 * 2. url_verification → challenge.
 * 3. app_uninstalled / tokens_revoked (bot tokens) → team_id → that workspace's
 *    shared-app inbox(es) → disabled (approvals can no longer be sent through
 *    it) + admin audit + #236 alert (APPROVAL_DELIVERY_FAILURE_ALERT), then its
 *    encrypted secrets (botToken) are deleted (audit: teamId / deletedAt /
 *    reason / key names only). See lib/slack/shared-approval-revoke.ts.
 *    The org's binding to the workspace is kept (config.teamId stays), so a
 *    re-install by the same org reuses it and another org still cannot take it.
 *    Idempotent: a repeated event does nothing.
 * 4. Any other event / unknown team → 200 and ignored.
 */
import { findSharedApprovalChannelsByTeam } from "@/lib/data/notification-channels";
import { verifySlackSignature } from "@/lib/notify/slack";
import { isSharedApprovalAppEnabled, sharedApprovalAppConfig } from "@/lib/slack/shared-approval-app";
import { retireSharedApprovalInbox } from "@/lib/slack/shared-approval-revoke";

export const SHARED_APPROVAL_APP_BOT_EVENTS = ["app_uninstalled", "tokens_revoked"] as const;

type Envelope = {
  type?: string;
  challenge?: string;
  api_app_id?: string;
  team_id?: string;
  event?: { type?: string; tokens?: { oauth?: unknown[]; bot?: unknown[] } };
};

export type SharedEventResult = { status: number; body: Record<string, unknown> };

export async function handleSharedApprovalAppEvent(input: {
  rawBody: string;
  timestamp: string;
  signature: string;
  nowMs?: number;
}): Promise<SharedEventResult> {
  if (!isSharedApprovalAppEnabled()) return { status: 404, body: { ok: false, error: "not_found" } };
  const config = sharedApprovalAppConfig();
  if (!config) return { status: 503, body: { ok: false, error: "unconfigured" } };
  const verified = verifySlackSignature({
    signingSecret: config.signingSecret,
    timestamp: input.timestamp,
    rawBody: input.rawBody,
    signature: input.signature,
    nowMs: input.nowMs,
  });
  if (!verified) return { status: 401, body: { ok: false, error: "unauthorized" } };

  let envelope: Envelope;
  try {
    envelope = JSON.parse(input.rawBody || "{}") as Envelope;
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }
  if (envelope.type === "url_verification") {
    return { status: 200, body: { challenge: String(envelope.challenge || "") } };
  }
  if (envelope.type !== "event_callback") return { status: 200, body: { ok: true, ignored: true, reason: "not_event_callback" } };
  if (envelope.api_app_id && envelope.api_app_id !== config.appId) {
    return { status: 200, body: { ok: true, ignored: true, reason: "app_mismatch" } };
  }
  const eventType = String(envelope.event?.type || "");
  let reason: "app_uninstalled" | "tokens_revoked" | null = null;
  if (eventType === "app_uninstalled") reason = "app_uninstalled";
  if (eventType === "tokens_revoked") {
    const bot = envelope.event?.tokens?.bot;
    // This app only holds bot tokens; user-token revocations do not affect it.
    if (Array.isArray(bot) && bot.length > 0) reason = "tokens_revoked";
  }
  if (!reason) return { status: 200, body: { ok: true, ignored: true, reason: "event_not_handled" } };

  const teamId = String(envelope.team_id || "").trim();
  const inboxes = await findSharedApprovalChannelsByTeam({ appId: config.appId, teamId, enabledOnly: false });
  if (inboxes.length === 0) return { status: 200, body: { ok: true, ignored: true, reason: "unknown_team" } };

  let disabled = 0;
  let purged = 0;
  for (const inbox of inboxes) {
    // Idempotent: an already-disabled inbox with no secrets left is a no-op.
    const retired = await retireSharedApprovalInbox({ inbox, reason, source: "events" });
    if (retired.disabled) disabled += 1;
    if (retired.deletedKeys.length > 0) purged += 1;
  }
  return { status: 200, body: { ok: true, disabled, purged } };
}
