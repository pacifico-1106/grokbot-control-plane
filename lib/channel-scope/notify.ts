/**
 * P1 Channel Scope — CS4 approver info card on Slack Connect invites.
 *
 * Design §4.3.8: when an AI employee is invited to (or a channel it is in becomes) an external
 * Slack Connect channel, send an INFORMATION card (no buttons, nothing to approve) to the
 * employee's approver inbox (resolveEmployeeApprovalChannel — same inbox as approvals).
 *
 * Guards (fail-closed: skip, never widen):
 * - Never delivered into the Connect channel itself, and never into a Slack inbox that is
 *   itself shared / cannot be verified (same check as approval cards, recipient-routing.ts).
 * - policy.connect.notifyApproverOnInvite=false ⇒ skip.
 * - Text only: channel id, peer team ids, inviter id / team, employee display name. No message
 *   bodies, no tokens.
 * - Delivery failures are audited and never break event processing.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { resolveEmployeeApprovalChannel, type NotificationChannelRuntime } from "@/lib/data/notification-channels";
import { createDeliveryAdapter } from "@/lib/notify/delivery-adapter";
import "@/lib/notify/slack-delivery-adapter";
import { sendSlackTextToChannel } from "@/lib/notify/slack";
import { sendTelegramTextToChannel } from "@/lib/notify/telegram";
import { sendLineText } from "@/lib/notify/line";

export type ConnectInviteKind = "invited" | "shared_later";

export interface ConnectInviteCardInput {
  orgId: string;
  employee: { id: string; displayName?: string | null; approvalChannelId?: string | null } | null;
  channelId: string;
  externalTeamIds: string[];
  inviterSlackUserId?: string | null;
  inviterTeamId?: string | null;
  inScope: boolean;
  kind: ConnectInviteKind;
  eventId: string;
}

export interface ConnectInviteCardResult {
  sent: boolean;
  provider?: string;
  notificationChannelId?: string;
  reason?: string;
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildConnectInviteCardText(input: ConnectInviteCardInput): string {
  const who = input.employee?.displayName?.trim() || "AI社員";
  const peers = input.externalTeamIds.length ? input.externalTeamIds.join(", ") : "不明";
  const head =
    input.kind === "invited"
      ? `【お知らせ】${who} が外部 Slack Connect チャンネル ${input.channelId}（相手 team: ${peers}）に招待されました。`
      : `【お知らせ】${who} が参加しているチャンネル ${input.channelId} が外部と共有されました（相手 team: ${peers}）。`;
  const inviter = input.inviterSlackUserId
    ? `招待者: ${input.inviterSlackUserId}${input.inviterTeamId ? `（team ${input.inviterTeamId}）` : "（team 不明）"}`
    : null;
  const effect = input.inScope
    ? "このチャンネルへの送信は、人が分類を確定するまですべて承認制です（channels.classify で確定）。"
    : "このチャンネルはチャンネル範囲の対象外のため、AI社員は反応しません（範囲は channelScope.patch で変更）。";
  return [head, inviter, effect, "※ このメッセージは情報のみです（操作は不要）。"].filter(Boolean).join("\n");
}

async function deliver(channel: NotificationChannelRuntime, text: string): Promise<{ ok: boolean; error?: string }> {
  if (channel.provider === "slack") {
    const r = await sendSlackTextToChannel(channel, text);
    return { ok: Boolean(r.ok), error: r.ok ? undefined : r.error ?? (r.skipped ? "skipped" : "send_failed") };
  }
  if (channel.provider === "telegram") {
    const r = await sendTelegramTextToChannel(channel, escapeHtml(text));
    return { ok: Boolean(r.ok), error: r.ok ? undefined : r.error ?? (r.skipped ? "skipped" : "send_failed") };
  }
  if (channel.provider === "line") {
    const r = await sendLineText(channel, text);
    return { ok: Boolean(r.ok), error: r.ok ? undefined : r.error ?? (r.skipped ? "skipped" : "send_failed") };
  }
  return { ok: false, error: "unsupported_provider" };
}

export async function sendConnectInviteInfoCard(input: ConnectInviteCardInput): Promise<ConnectInviteCardResult> {
  const skip = async (reason: string, extra: Record<string, unknown> = {}): Promise<ConnectInviteCardResult> => {
    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: input.employee?.id ?? null,
      credentialId: null,
      action: "channel_scope.connect_invite_notify_skipped",
      purpose: "channel_scope.ingress",
      summary: `Connect 招待のお知らせを送らなかった: ${reason}`,
      metadata: { channelId: input.channelId, reason, kind: input.kind, eventId: input.eventId, ...extra },
    }).catch(() => undefined);
    return { sent: false, reason, ...extra };
  };
  try {
    const inbox = await resolveEmployeeApprovalChannel(input.orgId, input.employee);
    if (!inbox) return skip("no_approver_inbox");
    const base = { provider: inbox.provider, notificationChannelId: inbox.id };
    if (inbox.provider === "slack") {
      const target = String(inbox.config?.channelId || "").trim().toUpperCase();
      if (target && target === input.channelId.toUpperCase()) return skip("inbox_is_connect_channel", base);
      const adapter = await createDeliveryAdapter("slack", inbox.id, input.orgId);
      if (!adapter) return skip("no_adapter", base);
      const shared = await adapter.isSharedChannel();
      if (shared.shared) return skip(`inbox_shared:${shared.reason ?? "unknown"}`, base);
    }
    const result = await deliver(inbox, buildConnectInviteCardText(input));
    if (!result.ok) return skip(`delivery_failed:${result.error ?? "unknown"}`, base);
    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: input.employee?.id ?? null,
      credentialId: null,
      action: "channel_scope.connect_invite_notified",
      purpose: "channel_scope.ingress",
      summary: `Connect 招待のお知らせを承認者に送信: ${input.channelId}`,
      metadata: {
        channelId: input.channelId,
        externalTeamIds: input.externalTeamIds,
        inviterSlackUserId: input.inviterSlackUserId ?? null,
        inviterTeamId: input.inviterTeamId ?? null,
        inScope: input.inScope,
        kind: input.kind,
        eventId: input.eventId,
        ...base,
      },
    }).catch(() => undefined);
    return { sent: true, ...base };
  } catch (error) {
    return skip(`error:${error instanceof Error ? error.message : "unknown"}`);
  }
}
