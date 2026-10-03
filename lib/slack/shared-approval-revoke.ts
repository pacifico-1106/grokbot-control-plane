/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED: retire a shared approval app inbox whose
 * bot token is gone. Triggered by
 *   - Events: app_uninstalled / tokens_revoked (bot) — lib/slack/shared-approval-events.ts
 *   - Delivery: Slack answering token_revoked / invalid_auth / account_inactive
 *     to an approval card sent with the shared xoxb — lib/notify/channels.ts
 *
 * 1. Delete the inbox's encrypted secrets (botToken). Audit: teamId, deletedAt,
 *    reason, deleted key NAMES only — never the token.
 * 2. Disable the inbox (config.disabledReason / disabledAt / secretsPurgedAt;
 *    teamId kept so no other org can take the workspace) + admin audit.
 * 3. #236 alert with the reconnect step — on EVERY deletion (throttle bypassed),
 *    never on an idempotent repeat.
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

/** Next step shown in the #236 alert and in setup.slackDmApprovalStatus (no full URL on purpose). */
export const SHARED_APPROVAL_CONNECTION_LOST_NEXT_STEP_JA =
  "共通承認アプリの接続が切れました。owner/admin が Staffpass にログインした状態で install/start を開き、「許可する」を押せば戻ります";

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
  // Only the shared app's own inbox; a per-tenant inbox is never touched.
  if (inbox.provider !== "slack" || !isSharedApprovalAppChannelConfig(inbox.config)) return out;
  const teamId = String(inbox.config.teamId || "");

  // 1. Delete the token (this inbox only, org-scoped, idempotent).
  try {
    const { deletedKeys } = await purgeSharedApprovalChannelSecrets({ orgId: inbox.orgId, channelId: inbox.id });
    out.deletedKeys = deletedKeys;
  } catch (error) {
    console.error("slack_shared_approval_secret_purge_failed", inbox.id, String((error as Error)?.message || ""));
  }
  const deleted = out.deletedKeys.length > 0;

  // 2. Disable (+ record the deletion so the status can show it). Nothing to
  //    re-save: the secrets are already gone.
  if (inbox.enabled || deleted) {
    const at = new Date().toISOString();
    try {
      await upsertNotificationChannel({
        id: inbox.id,
        orgId: inbox.orgId,
        provider: "slack",
        label: inbox.label,
        enabled: false,
        isDefault: inbox.isDefault,
        config: {
          ...inbox.config,
          disabledReason: inbox.enabled ? reason : String(inbox.config.disabledReason || reason),
          disabledAt: inbox.enabled ? at : String(inbox.config.disabledAt || at),
          ...(deleted ? { secretsPurgedAt: at, secretsPurgedReason: reason } : {}),
        },
        secrets: {},
      });
      out.disabled = inbox.enabled;
    } catch (error) {
      console.error("slack_shared_approval_disable_failed", inbox.id, String((error as Error)?.message || ""));
    }
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
  }
  if (deleted) {
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
  // 3. #236: every deletion alerts (forced past the throttle — a deletion happens
  //    once per install); a repeat (nothing deleted, already disabled) does not.
  if (deleted || out.disabled) {
    await alertApprovalDeliveryFailure({
      orgId: inbox.orgId,
      kind: "delivery_failed",
      approvalId: null,
      provider: "slack",
      channelId: inbox.id,
      reason,
      nextStepJa: SHARED_APPROVAL_CONNECTION_LOST_NEXT_STEP_JA,
      force: deleted,
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
