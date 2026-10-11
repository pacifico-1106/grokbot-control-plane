import {
  alertApprovalDeliveryFailure,
  isApprovalDeliveryFailureAlertEnabled,
} from "@/lib/notify/delivery-failure-alert";
import {
  appendAuditEvent,
  getEnabledNotificationChannels,
  getTokyo307PilotOrgId,
  isTokyo307PilotOrg,
  listAllEnabledNotificationChannels,
  listApprovals,
  listEmployees,
  resolveEmployeeApprovalChannel,
  type NotificationChannelRuntime,
} from "@/lib/data";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { buildConcentration, type ConcentrationReport } from "@/lib/employees/concentration";
import type { ApprovalRequest, Employee, WorkflowProgress } from "@/lib/types";
import { getApprovalWorkflowProgress, getCurrentStageVoterUserIds } from "@/lib/approval-workflow/resolve";
import { isInboxRoutingEnabled } from "@/lib/feature-flags";
import { routeInboxToResponsibleHuman } from "@/lib/notify/inbox-routing";
import { isSharedApprovalAppEnabled } from "@/lib/slack/shared-approval-flags";
/**
 * Org notification channels (Telegram / LINE / Slack).
 * Slack here is the approval *inbox* only. Conversation posting uses
 * org_conversation_adapters — never mix with comm.send / slack.post.
 */
import {
  editTelegramApprovalForChannel,
  ensureGlobalTelegramWebhook,
  escapeTelegramHtml,
  sendApprovalToTelegram,
  sendApprovalToTelegramChannel,
  sendTelegramText,
  sendTelegramTextToChannel,
} from "@/lib/notify/telegram";
import {
  resolveLineApprovalMessage,
  sendApprovalToLineChannel,
  sendLineText,
} from "@/lib/notify/line";
import {
  editSlackApprovalForChannel,
  sendApprovalToSlackChannel,
  sendSlackTextToChannel,
  editSlackWorkflowProgress,
  refreshSlackApprovalCard,
  sendSlackDmToUser,
  type WorkflowProgressDisplay,
} from "@/lib/notify/slack";

function workflowDisplay(progress: WorkflowProgress | null): WorkflowProgressDisplay | null {
  if (!progress) return null;
  return { stageName: progress.currentStage?.nameJa || "最終Go", approved: progress.currentStage?.approved || 0,
    pending: progress.currentStage?.pending || 0, quorum: progress.currentStage?.quorumDisplay || "",
    finalGoPending: progress.finalGoPending };
}

/**
 * Resolve the notification channel for an approval.
 *
 * Admin-class approvals (isAdminClassApproval) are routed to the org default/admin inbox,
 * NOT to an employee's business approval channel. This ensures admin operations are always
 * visible to org-level approvers (Telegram currently).
 *
 * Business-class approvals use the employee's configured channel or org default.
 */
async function resolveApprovalNotificationChannel(
  approval: ApprovalRequest,
  employee?: { approvalChannelId?: string | null } | null
): Promise<NotificationChannelRuntime | null> {
  const channels = await getEnabledNotificationChannels(approval.orgId);
  const defaultChannel = channels.find((channel) => channel.isDefault) ?? channels[0] ?? null;

  if (isAdminClassApproval(approval)) {
    return defaultChannel;
  }

  return resolveEmployeeApprovalChannel(approval.orgId, employee);
}

export type NotificationDispatchResult = {
  ok: boolean;
  provider: "telegram" | "line" | "slack";
  channelId?: string;
  fallback?: boolean;
  skipped?: boolean;
  error?: string;
};

async function auditFailure(approval: ApprovalRequest, result: NotificationDispatchResult) {
  if (result.ok || result.skipped) return;
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action: "notification.delivery_failed",
    purpose: approval.purpose,
    summary: `${result.provider} 通知に失敗`,
    metadata: { approvalId: approval.id, channelId: result.channelId, error: result.error },
  });
}

export async function sendApprovalNotifications(
  approval: ApprovalRequest,
  employee: Employee | null
): Promise<NotificationDispatchResult[]> {
  const results: NotificationDispatchResult[] = [];

  if (isInboxRoutingEnabled() && !isAdminClassApproval(approval)) {
    const workflow = workflowDisplay(await getApprovalWorkflowProgress(approval.id));
    const stageVoterUserIds = await getCurrentStageVoterUserIds(approval.id);
    const routingResult = await routeInboxToResponsibleHuman({
      approval,
      employee,
      workflow,
      stageVoterUserIds: stageVoterUserIds ?? undefined,
    });

    if (!routingResult.fallbackToDefault && routingResult.deliveries.length > 0) {
      for (const delivery of routingResult.deliveries) {
        const result: NotificationDispatchResult = {
          ok: delivery.ok,
          provider: "slack",
          channelId: delivery.channel || undefined,
          error: delivery.error || undefined,
        };
        results.push(result);
        await auditFailure(approval, result);
      }
      if (results.some((r) => r.ok)) {
        return results;
      }
    }
  }

  const channel = await resolveApprovalNotificationChannel(approval, employee);
  if (channel) {
    const workflow = channel.provider === "slack" ? workflowDisplay(await getApprovalWorkflowProgress(approval.id)) : null;
    const sent = channel.provider === "telegram"
      ? await sendApprovalToTelegramChannel(approval, employee, channel)
      : channel.provider === "line"
        ? await sendApprovalToLineChannel(approval, employee, channel)
        : await sendApprovalToSlackChannel(approval, employee, channel, { workflow });
    const result = { ...sent, provider: channel.provider, channelId: channel.id } as NotificationDispatchResult;
    results.push(result);
    await auditFailure(approval, result);
    if (!result.ok && channel.provider === "slack" && channel.config?.sharedApprovalApp === true) {
      // SLACK_SHARED_APPROVAL_APP_ENABLED: Slack says the shared app's token is gone
      // (token_revoked / invalid_auth / account_inactive) → disable + delete secrets.
      // Lazy import: flag-gated inside, never throws.
      const { retireSharedApprovalInboxOnDeliveryError } = await import("@/lib/slack/shared-approval-revoke");
      await retireSharedApprovalInboxOnDeliveryError(channel, result.error);
    }
  }
  if (!channel && !isSharedApprovalAppEnabled()) {
    // Review M1: the org's shared approval app inbox is suspended (flag OFF) —
    // nothing was sent with its token; count it as a delivery failure (#236 below).
    const { findSuspendedSharedApprovalInbox } = await import("@/lib/data/notification-channels");
    const suspended =
      typeof findSuspendedSharedApprovalInbox === "function"
        ? await findSuspendedSharedApprovalInbox(approval.orgId).catch(() => null)
        : null;
    if (suspended) {
      const result: NotificationDispatchResult = {
        ok: false,
        provider: "slack",
        channelId: suspended.id,
        error: "shared_approval_app_disabled",
      };
      results.push(result);
      await auditFailure(approval, result);
    }
  }
  if (!channel && await isTokyo307PilotOrg(approval.orgId)) {
    const sent = await sendApprovalToTelegram(approval, employee);
    const result = { ...sent, provider: "telegram" as const, fallback: true };
    results.push(result);
    await auditFailure(approval, result);
  }
  await alertIfUndelivered(approval, results);
  return results;
}

/**
 * PR-3: a real approval that reached no inbox is the live-check failure
 * (there is no test approval). Flag-gated inside; never throws.
 */
async function alertIfUndelivered(approval: ApprovalRequest, results: NotificationDispatchResult[]) {
  if (!isApprovalDeliveryFailureAlertEnabled()) return;
  if (results.some((r) => r.ok)) return;
  const failed = results.find((r) => !r.ok && !r.skipped) ?? results[0];
  await alertApprovalDeliveryFailure({
    orgId: approval.orgId,
    kind: "delivery_failed",
    approvalId: approval.id,
    provider: failed?.provider ?? null,
    channelId: failed?.channelId ?? null,
    reason: failed ? failed.error || (failed.skipped ? "delivery_skipped" : "delivery_failed") : "no_approval_inbox",
  }).catch(() => undefined);
}

/** Refresh the existing card without sending completion callbacks or issuing new actions. */
export async function refreshWorkflowNotification(approval: ApprovalRequest, progress: WorkflowProgress): Promise<void> {
  const { getEmployee } = await import("@/lib/data/employees");
  const employee = await getEmployee(approval.employeeId, approval.orgId);
  const channel = await resolveEmployeeApprovalChannel(approval.orgId, employee);
  const display = workflowDisplay(progress);
  if (channel?.provider === "slack" && display) await editSlackWorkflowProgress(approval, employee, channel, display);
}

/**
 * PR-D: a designated admin approved an owner-required ticket. Tell the approval
 * inbox (Slack / LINE / Telegram, same text) that it is still オーナー承認待ち and
 * nothing was applied; the Slack card is re-rendered too. Best effort.
 */
export async function notifyOwnerApprovalPending(approval: ApprovalRequest): Promise<NotificationDispatchResult | null> {
  const { getEmployee } = await import("@/lib/data/employees");
  const employee = approval.employeeId ? await getEmployee(approval.employeeId, approval.orgId) : null;
  const channel = await resolveApprovalNotificationChannel(approval, employee);
  if (!channel) return null;
  const title = approval.title || approval.summary || approval.id.slice(0, 8);
  const lines = [
    `🔐 オーナー承認待ち: ${title}`,
    "指定管理者が承認しました。この変更はオーナーの承認が必要なため、まだ反映していません。",
  ];
  const sent = channel.provider === "telegram"
    ? await sendTelegramTextToChannel(channel, lines.map((line) => escapeTelegramHtml(line)).join("\n"))
    : channel.provider === "line"
      ? await sendLineText(channel, lines.join("\n"))
      : await sendSlackTextToChannel(channel, lines.join("\n"));
  if (channel.provider === "slack") await refreshSlackApprovalCard(approval, employee, channel).catch(() => undefined);
  const result = { ...sent, provider: channel.provider, channelId: channel.id } as NotificationDispatchResult;
  await auditFailure(approval, result);
  return result;
}

export async function updateApprovalNotificationMessages(
  approval: ApprovalRequest,
  decision: "approved" | "rejected" | "revision_requested",
  actor: string,
  employee?: Employee | null
): Promise<NotificationDispatchResult[]> {
  const channel = await resolveEmployeeApprovalChannel(approval.orgId, employee);
  const results: NotificationDispatchResult[] = [];
  if (channel) {
    const sent = channel.provider === "telegram"
      ? await editTelegramApprovalForChannel(approval, decision, actor, channel)
      : channel.provider === "line"
        ? await resolveLineApprovalMessage(approval, decision, actor, channel)
        : await editSlackApprovalForChannel(approval, decision, actor, channel);
    results.push({ ...sent, provider: channel.provider, channelId: channel.id });
  }
  if (!channel && !isSharedApprovalAppEnabled()) {
    // Review M1: the org's shared approval app inbox is suspended (flag OFF) —
    // nothing was sent with its token; count it as a delivery failure (#236 below).
    const { findSuspendedSharedApprovalInbox } = await import("@/lib/data/notification-channels");
    const suspended =
      typeof findSuspendedSharedApprovalInbox === "function"
        ? await findSuspendedSharedApprovalInbox(approval.orgId).catch(() => null)
        : null;
    if (suspended) {
      const result: NotificationDispatchResult = {
        ok: false,
        provider: "slack",
        channelId: suspended.id,
        error: "shared_approval_app_disabled",
      };
      results.push(result);
      await auditFailure(approval, result);
    }
  }
  if (!channel && await isTokyo307PilotOrg(approval.orgId)) {
    const { editTelegramApprovalMessage } = await import("@/lib/notify/telegram");
    results.push({ ...(await editTelegramApprovalMessage(approval, decision, actor)), provider: "telegram", fallback: true });
  }
  return results;
}

function digestText(
  approvals: ApprovalRequest[],
  html: boolean,
  concentration?: ConcentrationReport
): string {
  const now = Date.now();
  const pending = approvals.filter((item) => item.status === "pending");
  const stale = pending.filter((item) => now - new Date(item.createdAt).getTime() >= 86_400_000);
  const recent = approvals.filter((item) => item.resolvedAt && now - new Date(item.resolvedAt).getTime() <= 43_200_000);
  const count = (status: string) => recent.filter((item) => item.status === status).length;
  const esc = (value: string) => html ? escapeTelegramHtml(value) : value;
  const items = pending.slice(0, 10).map((item, index) => `${index + 1}. ${esc(item.title)} #${esc(item.id.slice(0, 8))}`);
  const concentrated = concentration?.employees.filter((row) => concentration.flagged.includes(row.employeeId)) ?? [];
  const concentrationLines = concentrated.length
    ? [
        "",
        `⚠️ 権限集中: ${concentrated.length}名`,
        ...concentrated.slice(0, 5).map((row) =>
          `・${esc(row.displayName)}: 高リスク領域 ${row.highRiskDomains.length}/${concentration?.orgHighRiskDomainCount || 0}`
        ),
      ]
    : [];
  return [
    "📋 StaffPass 承認ダイジェスト",
    `承認待ち: ${pending.length}件（24時間以上: ${stale.length}件）`,
    `直近12時間: ✅ ${count("approved")} / ❌ ${count("rejected")} / ✏️ ${count("revision_requested")}`,
    ...(items.length ? ["", "承認待ち 上位10件", ...items] : ["", "承認待ちはありません。"]),
    ...concentrationLines,
  ].join("\n");
}

export async function sendTenantDigests(): Promise<NotificationDispatchResult[]> {
  // 既存の Telegram 運用パス。グローバル bot の webhook を安価に張り直す。
  await ensureGlobalTelegramWebhook();
  const channels = await listAllEnabledNotificationChannels();
  const results: NotificationDispatchResult[] = [];
  const byOrg = new Map<string, Awaited<ReturnType<typeof listApprovals>>>();
  const concentrationByOrg = new Map<string, ConcentrationReport>();
  for (const channel of channels) {
    let approvals = byOrg.get(channel.orgId);
    if (!approvals) {
      approvals = await listApprovals(channel.orgId);
      byOrg.set(channel.orgId, approvals);
    }
    let concentration = concentrationByOrg.get(channel.orgId);
    if (!concentration) {
      concentration = buildConcentration(await listEmployees(channel.orgId));
      concentrationByOrg.set(channel.orgId, concentration);
    }
    const digest = digestText(approvals, channel.provider === "telegram", concentration);
    const sent = channel.provider === "telegram"
      ? await sendTelegramTextToChannel(channel, digest)
      : channel.provider === "line"
        ? await sendLineText(channel, digest)
        : await sendSlackTextToChannel(channel, digest);
    results.push({ ...sent, provider: channel.provider, channelId: channel.id });
  }
  const pilotOrgId = await getTokyo307PilotOrgId();
  if (pilotOrgId && !channels.some((channel) => channel.orgId === pilotOrgId && channel.provider === "telegram")) {
    const approvals = byOrg.get(pilotOrgId) || await listApprovals(pilotOrgId);
    const concentration = concentrationByOrg.get(pilotOrgId) || buildConcentration(await listEmployees(pilotOrgId));
    results.push({ ...(await sendTelegramText(digestText(approvals, true, concentration))), provider: "telegram", fallback: true });
  }
  return results;
}

export interface OwnerApprovedNoticeResult {
  owners: number;
  slackDmSent: number;
  slackDmFailed: number;
  ownersWithoutSlack: number;
  channelPost: { provider: string; ok: boolean } | null;
}

/**
 * PR-D 確定仕様: once an approver-authority ticket is approved, tell every
 * other active owner — Slack DM via each owner's verified Slack voter binding
 * (sent with that binding's approval inbox bot), and the same text in the
 * org's LINE / Telegram approval inbox. The text never carries the title,
 * summary, arguments or secrets (approverAuthorityApprovedNoticeJa). Audit
 * records counts only. Best effort: never affects the approval.
 */
export async function notifyOwnersApproverAuthorityApproved(
  approval: ApprovalRequest
): Promise<OwnerApprovedNoticeResult> {
  const { getOrgOwners, getMemberById } = await import("@/lib/data/members");
  const { approverAuthorityApprovedNoticeJa } = await import("@/lib/approver-authority/reply");
  const approverId = (approval.approverMemberId || "").trim();
  const approver = approverId ? await getMemberById(approverId, approval.orgId).catch(() => null) : null;
  const text = approverAuthorityApprovedNoticeJa({
    tool: approval.tool,
    approvalId: approval.id,
    approverRole: approval.approverRole,
    approverDisplayName: approver?.displayName ?? null,
  });
  const owners = (await getOrgOwners(approval.orgId)).filter(
    (m) => m.orgId === approval.orgId && m.status === "active" && m.id !== approverId
  );
  const result: OwnerApprovedNoticeResult = { owners: owners.length, slackDmSent: 0, slackDmFailed: 0, ownersWithoutSlack: 0, channelPost: null };
  if (owners.length === 0) return result;
  const channels = await getEnabledNotificationChannels(approval.orgId);
  const dm = await dmMembersViaVerifiedSlack(approval.orgId, owners.map((o) => o.id), text, channels);
  result.slackDmSent = dm.sent;
  result.slackDmFailed = dm.failed;
  result.ownersWithoutSlack = dm.withoutSlack;
  const inbox = await resolveApprovalNotificationChannel(approval, null).catch(() => null);
  if (inbox && (inbox.provider === "line" || inbox.provider === "telegram")) {
    const sent = inbox.provider === "telegram"
      ? await sendTelegramTextToChannel(inbox, escapeTelegramHtml(text)).catch(() => ({ ok: false }))
      : await sendLineText(inbox, text).catch(() => ({ ok: false }));
    result.channelPost = { provider: inbox.provider, ok: Boolean(sent.ok) };
  }
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId || null,
    credentialId: null,
    action: "admin.policy",
    purpose: "approver_authority.owner_notice",
    summary: `承認の事後通知（オーナー ${result.owners} 人）`,
    metadata: { approvalId: approval.id, tool: approval.tool ?? null, ...result },
  }).catch(() => undefined);
  return result;
}

/**
 * Slack DM to members via each member's verified (active) Slack voter binding,
 * sent with that binding's own approval inbox bot. No binding → counted, skipped.
 */
async function dmMembersViaVerifiedSlack(
  orgId: string,
  memberIds: readonly string[],
  text: string,
  channels: Awaited<ReturnType<typeof getEnabledNotificationChannels>>
): Promise<{ sent: number; failed: number; withoutSlack: number }> {
  const { listVoterBindings } = await import("@/lib/approval-workflow/voter-binding");
  const out = { sent: 0, failed: 0, withoutSlack: 0 };
  for (const memberId of memberIds) {
    const bindings = (await listVoterBindings({ orgId, memberId, provider: "slack" }).catch(() => []))
      .filter((b) => b.status === "active" && b.memberId === memberId);
    const binding = bindings.find((b) => channels.some((c) => c.id === b.channelKey && c.provider === "slack"));
    if (!binding) {
      out.withoutSlack++;
      continue;
    }
    const channel = channels.find((c) => c.id === binding.channelKey && c.provider === "slack")!;
    const sent = await sendSlackDmToUser(channel, binding.externalUserId, text).catch(() => ({ ok: false }));
    if (sent.ok) out.sent++;
    else out.failed++;
  }
  return out;
}

export type OwnerPromotedNoticeResult = {
  recipients: number;
  slackDmSent: number;
  slackDmFailed: number;
  withoutSlack: number;
  channelPost: { provider: "line" | "telegram"; ok: boolean } | null;
};

/**
 * members.promoteOwner applied: tell every active owner (the new one included)
 * and the target — Slack DM via verified bindings + the org's LINE / Telegram
 * approval inbox. Names + short ticket id only (ownerPromotedNoticeJa). Audit
 * records counts only. Best effort: never undoes the promotion.
 */
export async function notifyOwnerPromoted(
  approval: ApprovalRequest,
  input: { targetMemberId: string; approverMemberId: string }
): Promise<OwnerPromotedNoticeResult> {
  const { getOrgOwners, getMemberById } = await import("@/lib/data/members");
  const { ownerPromotedNoticeJa } = await import("@/lib/approver-authority/reply");
  const [target, approver] = await Promise.all([
    getMemberById(input.targetMemberId, approval.orgId).catch(() => null),
    getMemberById(input.approverMemberId, approval.orgId).catch(() => null),
  ]);
  const text = ownerPromotedNoticeJa({
    approvalId: approval.id,
    targetDisplayName: target?.displayName ?? null,
    approverDisplayName: approver?.displayName ?? null,
  });
  const ids = new Set(
    (await getOrgOwners(approval.orgId))
      .filter((m) => m.orgId === approval.orgId && m.status === "active")
      .map((m) => m.id)
  );
  ids.add(input.targetMemberId);
  const result: OwnerPromotedNoticeResult = { recipients: ids.size, slackDmSent: 0, slackDmFailed: 0, withoutSlack: 0, channelPost: null };
  const channels = await getEnabledNotificationChannels(approval.orgId);
  const dm = await dmMembersViaVerifiedSlack(approval.orgId, [...ids], text, channels);
  result.slackDmSent = dm.sent;
  result.slackDmFailed = dm.failed;
  result.withoutSlack = dm.withoutSlack;
  const inbox = await resolveApprovalNotificationChannel(approval, null).catch(() => null);
  if (inbox && (inbox.provider === "line" || inbox.provider === "telegram")) {
    const sent = inbox.provider === "telegram"
      ? await sendTelegramTextToChannel(inbox, escapeTelegramHtml(text)).catch(() => ({ ok: false }))
      : await sendLineText(inbox, text).catch(() => ({ ok: false }));
    result.channelPost = { provider: inbox.provider, ok: Boolean(sent.ok) };
  }
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "owner_promotion.notice",
    summary: `オーナー追加の通知（${result.recipients} 人）`,
    metadata: { approvalId: approval.id, tool: "members.promoteOwner", targetMemberId: input.targetMemberId, ...result },
  }).catch(() => undefined);
  return result;
}
