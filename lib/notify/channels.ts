import {
  appendAuditEvent,
  getEnabledNotificationChannels,
  getTokyo307PilotOrgId,
  isTokyo307PilotOrg,
  listAllEnabledNotificationChannels,
  listApprovals,
  listEmployees,
} from "@/lib/data";
import { buildConcentration, type ConcentrationReport } from "@/lib/employees/concentration";
import type { ApprovalRequest, Employee } from "@/lib/types";
/**
 * Org notification channels (Telegram / LINE).
 * Slack DM notify is reserved as a future provider extension point and is
 * NOT a conversation adapter. Do not mix with org_parties / comm.send.
 */
import {
  editTelegramApprovalForChannel,
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

export type NotificationDispatchResult = {
  ok: boolean;
  provider: "telegram" | "line";
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
  const channels = await getEnabledNotificationChannels(approval.orgId);
  const results: NotificationDispatchResult[] = [];
  for (const channel of channels) {
    const sent = channel.provider === "telegram"
      ? await sendApprovalToTelegramChannel(approval, employee, channel)
      : await sendApprovalToLineChannel(approval, employee, channel);
    const result = { ...sent, provider: channel.provider, channelId: channel.id } as NotificationDispatchResult;
    results.push(result);
    await auditFailure(approval, result);
  }
  if (!channels.some((channel) => channel.provider === "telegram") && await isTokyo307PilotOrg(approval.orgId)) {
    const sent = await sendApprovalToTelegram(approval, employee);
    const result = { ...sent, provider: "telegram" as const, fallback: true };
    results.push(result);
    await auditFailure(approval, result);
  }
  return results;
}

export async function updateApprovalNotificationMessages(
  approval: ApprovalRequest,
  decision: "approved" | "rejected" | "revision_requested",
  actor: string
): Promise<NotificationDispatchResult[]> {
  const channels = await getEnabledNotificationChannels(approval.orgId);
  const results: NotificationDispatchResult[] = [];
  for (const channel of channels) {
    const sent = channel.provider === "telegram"
      ? await editTelegramApprovalForChannel(approval, decision, actor, channel)
      : await resolveLineApprovalMessage(approval, decision, actor, channel);
    results.push({ ...sent, provider: channel.provider, channelId: channel.id });
  }
  if (!channels.some((channel) => channel.provider === "telegram") && await isTokyo307PilotOrg(approval.orgId)) {
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
    const sent = channel.provider === "telegram"
      ? await sendTelegramTextToChannel(channel, digestText(approvals, true, concentration))
      : await sendLineText(channel, digestText(approvals, false, concentration));
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
