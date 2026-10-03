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
 *    it) + admin audit + #236 alert (APPROVAL_DELIVERY_FAILURE_ALERT).
 *    The org's binding to the workspace is kept (config.teamId stays), so a
 *    re-install by the same org reuses it and another org still cannot take it.
 * 4. Any other event / unknown team → 200 and ignored.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { findSharedApprovalChannelsByTeam, upsertNotificationChannel } from "@/lib/data/notification-channels";
import { alertApprovalDeliveryFailure } from "@/lib/notify/delivery-failure-alert";
import { verifySlackSignature } from "@/lib/notify/slack";
import { isSharedApprovalAppEnabled, sharedApprovalAppConfig } from "@/lib/slack/shared-approval-app";

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
  for (const inbox of inboxes) {
    if (!inbox.enabled) continue;
    const at = new Date().toISOString();
    try {
      await upsertNotificationChannel({
        id: inbox.id,
        orgId: inbox.orgId,
        provider: "slack",
        label: inbox.label,
        enabled: false,
        isDefault: inbox.isDefault,
        config: { ...inbox.config, disabledReason: reason, disabledAt: at },
        secrets: {},
      });
      disabled += 1;
    } catch (error) {
      console.error("slack_shared_approval_disable_failed", inbox.id, String((error as Error)?.message || ""));
      continue;
    }
    await appendAuditEvent({
      orgId: inbox.orgId,
      employeeId: null,
      credentialId: null,
      actorEmail: "slack_shared_approval_events",
      action: "admin.notificationChannel",
      purpose: "admin.notificationChannel",
      summary: `共通承認アプリが Slack から外されたため承認口を無効にしました（${reason}）。承認依頼は届きません`,
      metadata: { auditClass: "admin", event: "shared_approval_app.disabled", reason, inboxId: inbox.id, teamId },
    }).catch(() => undefined);
    await alertApprovalDeliveryFailure({
      orgId: inbox.orgId,
      kind: "delivery_failed",
      approvalId: null,
      provider: "slack",
      channelId: inbox.id,
      reason,
    }).catch(() => undefined);
  }
  return { status: 200, body: { ok: true, disabled } };
}
