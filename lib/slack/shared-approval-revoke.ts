/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED: retire a shared approval app inbox whose
 * bot token is gone. Triggered by
 *   - Events: app_uninstalled / tokens_revoked (bot) — lib/slack/shared-approval-events.ts
 *   - Delivery: Slack answering token_revoked / invalid_auth / account_inactive
 *     to an approval card sent with the shared xoxb — lib/notify/channels.ts
 *
 * 1. Disable the inbox (config.disabledReason / disabledAt; teamId kept so no
 *    other org can take the workspace) + admin audit + #236 alert — only when it
 *    was still enabled.
 * 2. Delete the inbox's encrypted secrets (botToken). Audit: teamId, deletedAt,
 *    reason, deleted key NAMES only — never the token.
 * Idempotent: a repeat (already disabled, no secrets) does nothing and writes no
 * audit. Only the given (orgId, inbox) with the shared-app marker is touched.
 * A re-install by the same org stores a new token and re-enables the inbox.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import {
  isSharedApprovalAppChannelConfig,
  purgeSharedApprovalChannelSecrets,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { alertApprovalDeliveryFailure } from "@/lib/notify/delivery-failure-alert";
import { isSharedApprovalAppEnabled } from "@/lib/slack/shared-approval-flags";
import type { NotificationChannel } from "@/lib/types";

export const SHARED_APPROVAL_REVOKED_SLACK_ERRORS = ["token_revoked", "invalid_auth", "account_inactive"] as const;

export type SharedApprovalRetireReason =
  | "app_uninstalled"
  | "tokens_revoked"
  | (typeof SHARED_APPROVAL_REVOKED_SLACK_ERRORS)[number];

export type SharedApprovalRetireResult = { disabled: boolean; deletedKeys: string[] };

export async function retireSharedApprovalInbox(input: {
  inbox: NotificationChannel;
  reason: SharedApprovalRetireReason;
  source: "events" | "delivery";
}): Promise<SharedApprovalRetireResult> {
  const { inbox, reason } = input;
  const out: SharedApprovalRetireResult = { disabled: false, deletedKeys: [] };
  if (inbox.provider !== "slack" || !isSharedApprovalAppChannelConfig(inbox.config)) return out;
  const teamId = String(inbox.config.teamId || "");

  if (inbox.enabled) {
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
      out.disabled = true;
    } catch (error) {
      console.error("slack_shared_approval_disable_failed", inbox.id, String((error as Error)?.message || ""));
    }
    if (out.disabled) {
      await appendAuditEvent({
        orgId: inbox.orgId,
        employeeId: null,
        credentialId: null,
        actorEmail: "slack_shared_approval_events",
        action: "admin.notificationChannel",
        purpose: "admin.notificationChannel",
        summary: `共通承認アプリが使えなくなったため承認口を無効にしました（${reason}）。承認依頼は届きません`,
        metadata: { auditClass: "admin", event: "shared_approval_app.disabled", reason, source: input.source, inboxId: inbox.id, teamId },
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
  }

  // Delete after disabling: the disable upsert re-saves the merged secrets.
  try {
    const { deletedKeys } = await purgeSharedApprovalChannelSecrets({ orgId: inbox.orgId, channelId: inbox.id });
    out.deletedKeys = deletedKeys;
  } catch (error) {
    console.error("slack_shared_approval_secret_purge_failed", inbox.id, String((error as Error)?.message || ""));
  }
  if (out.deletedKeys.length > 0) {
    const deletedAt = new Date().toISOString();
    await appendAuditEvent({
      orgId: inbox.orgId,
      employeeId: null,
      credentialId: null,
      actorEmail: "slack_shared_approval_events",
      action: "admin.notificationChannel",
      purpose: "admin.notificationChannel",
      summary: `共通承認アプリの保存済み token を削除しました（${reason}）。再インストールで戻せます`,
      metadata: {
        auditClass: "admin",
        event: "shared_approval_app.secrets_purged",
        teamId,
        deletedAt,
        reason,
        deletedKeys: out.deletedKeys,
        source: input.source,
        inboxId: inbox.id,
      },
    }).catch(() => undefined);
  }
  return out;
}

/**
 * Delivery path: Slack said the shared app's token is no longer valid. Flag-gated,
 * shared-app inboxes only, never throws.
 */
export async function retireSharedApprovalInboxOnDeliveryError(
  inbox: NotificationChannel,
  slackError: string | null | undefined
): Promise<SharedApprovalRetireResult | null> {
  try {
    if (!isSharedApprovalAppEnabled()) return null;
    if (inbox.provider !== "slack" || !isSharedApprovalAppChannelConfig(inbox.config)) return null;
    const code = String(slackError || "").trim();
    const reason = (SHARED_APPROVAL_REVOKED_SLACK_ERRORS as readonly string[]).includes(code)
      ? (code as SharedApprovalRetireReason)
      : null;
    if (!reason) return null;
    return await retireSharedApprovalInbox({ inbox, reason, source: "delivery" });
  } catch {
    return null;
  }
}
