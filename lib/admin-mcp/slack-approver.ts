/**
 * Admin MCP for the shared approval app 「Staffpass承認」
 * (SLACK_SHARED_APPROVAL_APP_ENABLED, default OFF).
 *
 *   setup.slackApprover.set  always_human. Sets the approver (one Slack U…) of
 *                            this org's shared-approval-app inbox; after human
 *                            approval the #235 DM auto-open runs (users.info
 *                            checks: same workspace, not guest / bot / external)
 *                            and exactly one 「設定しました」 is posted. Nothing is
 *                            saved if any step fails.
 *   sharedApprovalAppStatus  (read-only block inside setup.slackDmApprovalStatus)
 *
 * Org always from the credential (fulfillment: from the approval row). No token
 * is accepted or returned. The approver must be a human member of the installed
 * workspace (users.info: not bot / guest / external). Self-approval stays
 * blocked at press time by the existing approval checks.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { rejectUnsafeArgs, type ToolOutcome } from "@/lib/admin-mcp/slack-dm-setup";
import { appendAuditEvent, listAuditEvents } from "@/lib/data/audit";
import {
  getNotificationChannelSecretsById,
  isSharedApprovalAppChannelConfig,
  listNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { openApprovalDeliveryDm, sendApprovalSetupNotice } from "@/lib/slack/approval-dm-open";
import {
  SHARED_APPROVAL_APP_NAME,
  isSharedApprovalAppEnabled,
  sharedApprovalAppConfig,
  sharedApprovalInstallStartUrl,
  sharedApprovalMessage,
} from "@/lib/slack/shared-approval-app";
import type { NotificationChannel } from "@/lib/types";

export const SLACK_APPROVER_SET_TOOL = "setup.slackApprover.set" as const;
export const SLACK_APPROVER_SET_ALLOWED_ARGS = ["slackUserId", "inboxId", "jobId", "approvalId"] as const;

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome {
  return { kind: "result", data: { ok: false, code, message, ...extra }, isError: true };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** This org's shared-approval-app inboxes (this app id only). */
async function sharedInboxes(orgId: string): Promise<NotificationChannel[]> {
  const appId = sharedApprovalAppConfig()?.appId || "";
  if (!appId) return [];
  return (await listNotificationChannels(orgId)).filter(
    (row) =>
      row.orgId === orgId &&
      row.provider === "slack" &&
      isSharedApprovalAppChannelConfig(row.config) &&
      str(row.config.apiAppId) === appId
  );
}

/** Latest install outcome of this org (from its own audit log). */
async function lastInstallEvent(orgId: string): Promise<{ ok: boolean; code: string; at: string } | null> {
  const events = await listAuditEvents(orgId, 100).catch(() => []);
  for (const event of events) {
    if (event.orgId !== orgId) continue;
    const name = str((event.metadata as Record<string, unknown> | undefined)?.event);
    if (name === "shared_approval_app.installed") return { ok: true, code: "installed", at: event.createdAt };
    if (name === "shared_approval_app.install_rejected") {
      return { ok: false, code: str((event.metadata as Record<string, unknown>).code) || "unknown", at: event.createdAt };
    }
  }
  return null;
}

/** Read-only status block (merged into setup.slackDmApprovalStatus when the flag is ON). */
export async function sharedApprovalAppStatus(orgId: string): Promise<{ status: Record<string, unknown>; nextStepsJa: string[] }> {
  const enabled = isSharedApprovalAppEnabled();
  const configured = Boolean(sharedApprovalAppConfig());
  const nextStepsJa: string[] = [];
  if (!enabled) return { status: { enabled: false }, nextStepsJa };
  if (!configured) {
    nextStepsJa.push("運営: 共通承認アプリ（Staffpass承認）の env（SLACK_SHARED_APPROVAL_APP_ID / CLIENT_ID / CLIENT_SECRET / SIGNING_SECRET）を設定してください。");
    return { status: { enabled: true, configured: false }, nextStepsJa };
  }
  const inboxes = await sharedInboxes(orgId);
  const inbox = inboxes.find((row) => row.enabled) ?? inboxes[0] ?? null;
  const last = await lastInstallEvent(orgId);
  const lastInstallError =
    last && !last.ok ? { code: last.code, messageJa: sharedApprovalMessage(last.code), at: last.at } : null;
  const approvers = inbox && Array.isArray(inbox.config.allowedUserIds) ? inbox.config.allowedUserIds.map(String) : [];
  const destination = str(inbox?.config.channelId);
  const installUrl = sharedApprovalInstallStartUrl();
  if (lastInstallError && (!inbox || !inbox.enabled)) {
    nextStepsJa.push(`${SHARED_APPROVAL_APP_NAME} のインストールが拒否されました（${lastInstallError.code}）: ${lastInstallError.messageJa}`);
  }
  if (!inbox || !inbox.enabled) {
    nextStepsJa.push(
      `${SHARED_APPROVAL_APP_NAME} を Slack に追加: この組織の owner/admin が Staffpass にログインした状態で ${installUrl} を開き、Slack で「許可する」（1 回）。` +
        (inbox && !inbox.enabled ? `（前回の承認口は ${str(inbox.config.disabledReason) || "無効"} のため止まっています）` : "")
    );
  } else if (approvers.length === 0 || !destination || typeof inbox.config.setupNoticeAt !== "string") {
    nextStepsJa.push(`承認する人を設定: setup.slackApprover.set（slackUserId=承認者の U…）→ 人の承認 1 回 → 承認者に「設定しました」が届きます。`);
  }
  return {
    status: {
      enabled: true,
      configured: true,
      appName: SHARED_APPROVAL_APP_NAME,
      installUrl,
      installed: Boolean(inbox),
      inboxId: inbox?.id ?? null,
      inboxEnabled: Boolean(inbox?.enabled),
      teamId: inbox ? str(inbox.config.teamId) || null : null,
      teamName: inbox ? str(inbox.config.teamName) || null : null,
      approverSlackUserIds: approvers,
      destinationKind: destination.startsWith("D") ? "dm" : destination ? "channel" : "none",
      setupNoticeSent: typeof inbox?.config.setupNoticeAt === "string",
      disabledReason: inbox && !inbox.enabled ? str(inbox.config.disabledReason) || null : null,
      lastInstallError,
    },
    nextStepsJa,
  };
}

async function resolveSharedInbox(
  orgId: string,
  inboxId: string
): Promise<{ ok: true; inbox: NotificationChannel } | { ok: false; code: string; messageJa: string }> {
  const inboxes = (await sharedInboxes(orgId)).filter((row) => row.enabled);
  const inbox = inboxId ? inboxes.find((row) => row.id === inboxId) : inboxes.length === 1 ? inboxes[0] : null;
  if (inbox) return { ok: true, inbox };
  if (inboxes.length > 1) return { ok: false, code: "inbox_ambiguous", messageJa: "共通承認アプリの承認口が複数あります。inboxId を指定してください。" };
  const last = await lastInstallEvent(orgId);
  if (last && !last.ok) return { ok: false, code: last.code, messageJa: sharedApprovalMessage(last.code) };
  return {
    ok: false,
    code: "shared_app_not_installed",
    messageJa: `${SHARED_APPROVAL_APP_NAME} がまだ Slack に追加されていません。owner/admin が ${sharedApprovalInstallStartUrl()} を開いて「許可する」を押してください。`,
  };
}

export async function handleSlackApproverSet(cred: ResolvedAdminCredential, args: Record<string, unknown>): Promise<ToolOutcome> {
  const unsafe = rejectUnsafeArgs(args, SLACK_APPROVER_SET_ALLOWED_ARGS);
  if (unsafe) return unsafe;
  if (!isSharedApprovalAppEnabled()) {
    return fail("feature_disabled", "SLACK_SHARED_APPROVAL_APP_ENABLED が OFF です（運営が ON にしてから使えます）。");
  }
  if (!sharedApprovalAppConfig()) return fail("unconfigured", sharedApprovalMessage("unconfigured"));
  const slackUserId = str(args.slackUserId);
  const inboxId = str(args.inboxId);
  if (!SLACK_USER_ID_RE.test(slackUserId)) return fail("invalid_slack_user_id", "slackUserId は承認者の Slack user ID（U…）で指定してください。");
  if (inboxId && !SAFE_ID_RE.test(inboxId)) return fail("invalid_inbox_id", "inboxId が不正です。");
  const resolved = await resolveSharedInbox(cred.orgId, inboxId);
  if (!resolved.ok) return fail(resolved.code, resolved.messageJa, { installUrl: sharedApprovalInstallStartUrl() });
  const previous = Array.isArray(resolved.inbox.config.allowedUserIds) ? resolved.inbox.config.allowedUserIds.map(String) : [];
  return {
    kind: "queue",
    queuedArgs: { inboxId: resolved.inbox.id, slackUserId, previousApproverCount: previous.length },
    summary:
      `${SHARED_APPROVAL_APP_NAME} の承認者を ${slackUserId} に設定し、承認アプリとの DM を開いて「設定しました」を 1 回送ることを人が確認します` +
      (previous.length ? `（今の承認者 ${previous.join(", ")} を置き換えます）` : ""),
  };
}

export type SlackApproverSetFulfillment =
  | { ok: true; inboxId: string; approverSlackUserId: string; destinationKind: "dm" }
  | { ok: false; code: string; messageJa: string; missingScope?: string };

/** Human-approved setup.slackApprover.set. Org from the approval row. */
export async function fulfillSlackApproverSet(input: {
  orgId: string;
  approvalId: string;
  args: Record<string, unknown>;
}): Promise<SlackApproverSetFulfillment> {
  const { orgId } = input;
  const auditFail = async (result: Extract<SlackApproverSetFulfillment, { ok: false }>) => {
    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "admin.notificationChannel",
      purpose: "admin.notificationChannel",
      summary: `${SHARED_APPROVAL_APP_NAME} の承認者設定を中止（${result.code}）`,
      metadata: { auditClass: "admin", event: "shared_approval_app.approver_set_failed", approvalId: input.approvalId, code: result.code },
    }).catch(() => undefined);
    return result;
  };
  if (!isSharedApprovalAppEnabled()) return auditFail({ ok: false, code: "feature_disabled", messageJa: "SLACK_SHARED_APPROVAL_APP_ENABLED が OFF です。" });
  if (!sharedApprovalAppConfig()) return auditFail({ ok: false, code: "unconfigured", messageJa: sharedApprovalMessage("unconfigured") });
  const slackUserId = str(input.args.slackUserId);
  if (!SLACK_USER_ID_RE.test(slackUserId)) return auditFail({ ok: false, code: "invalid_slack_user_id", messageJa: "Slack user ID が不正です。" });
  const resolved = await resolveSharedInbox(orgId, str(input.args.inboxId));
  if (!resolved.ok) return auditFail({ ok: false, code: resolved.code, messageJa: resolved.messageJa });
  const inbox = resolved.inbox;
  const botToken = str((await getNotificationChannelSecretsById(orgId, inbox.id)).botToken);
  const opened = await openApprovalDeliveryDm({ botToken, allowedUserIds: [slackUserId], deliveryUserId: slackUserId });
  if (!opened.ok) return auditFail({ ok: false, code: opened.code, messageJa: opened.messageJa, ...(opened.missingScope ? { missingScope: opened.missingScope } : {}) });
  const teamId = str(inbox.config.teamId);
  if (!teamId || opened.teamId !== teamId) {
    return auditFail({ ok: false, code: "team_mismatch", messageJa: "承認アプリの Slack ワークスペースが、インストールしたワークスペースと一致しません。" });
  }
  const notice = await sendApprovalSetupNotice(botToken, opened.channelId);
  if (!notice.ok) return auditFail({ ok: false, code: notice.code, messageJa: notice.messageJa, ...(notice.missingScope ? { missingScope: notice.missingScope } : {}) });
  const at = new Date().toISOString();
  await upsertNotificationChannel({
    id: inbox.id,
    orgId,
    provider: "slack",
    label: inbox.label,
    enabled: true,
    isDefault: inbox.isDefault,
    config: {
      ...inbox.config,
      allowedUserIds: [slackUserId],
      channelId: opened.channelId,
      expectedTeamId: teamId,
      autoOpened: { userId: opened.userId, at },
      setupNoticeAt: at,
    },
    secrets: {},
  });
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.notificationChannel",
    purpose: "admin.notificationChannel",
    summary: `${SHARED_APPROVAL_APP_NAME} の承認者を ${slackUserId} に設定（承認 DM を自動で開き「設定しました」送信済み・管理MCP・人承認）`,
    metadata: {
      auditClass: "admin",
      event: "shared_approval_app.approver_set",
      approvalId: input.approvalId,
      inboxId: inbox.id,
      approverSlackUserId: slackUserId,
      channelId: opened.channelId,
    },
  });
  return { ok: true, inboxId: inbox.id, approverSlackUserId: slackUserId, destinationKind: "dm" };
}
