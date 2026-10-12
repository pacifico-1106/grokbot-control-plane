/**
 * S3 inbox 「緊急停止」 buttons (Slack / LINE / Telegram). Inbox buttons can ONLY stop
 * (木村 10/12 07:15); release is web-only, so the reply always carries the web link.
 *
 * Gate (same as the approve buttons, plus a member binding):
 * - the card (approval ref) was delivered to THIS channel (and, on Slack, this message),
 * - the presser passes the employee's approver allow-list,
 * - the presser is bound to an active org member (voter binding) — started_by is
 *   `member:<uuid>` in S1, so an unbound presser is refused with a link to the web stop.
 */
import { getApprovalByTelegramRef } from "@/lib/data/approvals";
import { getNotificationDelivery } from "@/lib/data/notification-channels";
import { getEmployee } from "@/lib/data/employees";
import { getMemberById } from "@/lib/data/members";
import { extraApproversAllow } from "@/lib/employees/approval-inbox";
import { getMemberIdFromVoterBinding } from "@/lib/approval-workflow/data";
import { resolveAppOrigin } from "@/lib/app-url";
import { isEmployeeHoldEnabled } from "@/lib/safety/hold-config";
import { startHold } from "@/lib/safety/hold-actions";

export const HOLD_STOP_SLACK_ACTION_ID = "staffpass_emergency_stop";
/** LINE postback / Telegram callback_data prefix: `s:<telegramRef>` (≤ 64 bytes). */
export const HOLD_STOP_CALLBACK_PREFIX = "s:";

export function holdWebLink(employeeId: string | null): string {
  return employeeId ? `${resolveAppOrigin()}/app/employees/${employeeId}#hold` : `${resolveAppOrigin()}/app`;
}

export type InboxStopResult = { ok: boolean; code: string; text: string };

export async function stopFromInbox(input: {
  orgId: string;
  provider: "slack" | "line" | "telegram";
  channelId: string;
  userId: string;
  ref: string;
  externalMessageId?: string | null;
}): Promise<InboxStopResult> {
  const refuse = (code: string, text: string): InboxStopResult => ({ ok: false, code, text });
  if (!isEmployeeHoldEnabled()) return refuse("hold_disabled", "緊急停止はまだ有効になっていません。");
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(input.ref)) return refuse("not_found", "対象が見つかりません。");
  const approval = await getApprovalByTelegramRef(input.ref, input.orgId);
  if (!approval || approval.orgId !== input.orgId || !approval.employeeId) return refuse("not_found", "対象が見つかりません。");
  const delivery = await getNotificationDelivery({ approvalId: approval.id, channelId: input.channelId });
  if (!delivery || (input.externalMessageId && delivery.externalMessageId && delivery.externalMessageId !== input.externalMessageId)) {
    return refuse("delivery_mismatch", "このカードからは操作できません。");
  }
  const employee = await getEmployee(approval.employeeId, input.orgId);
  if (!employee || employee.orgId !== input.orgId) return refuse("not_found", "対象が見つかりません。");
  if (!extraApproversAllow(input.userId, employee.approverUserIds)) return refuse("forbidden", "この操作は許可されていません。");
  const memberId = await getMemberIdFromVoterBinding(input.orgId, { provider: input.provider, channelKey: input.channelId, userId: input.userId });
  const member = memberId ? await getMemberById(memberId, input.orgId) : null;
  if (!member || member.orgId !== input.orgId || member.status !== "active") {
    return refuse("member_binding_required", `メンバー連携がないため、ここからは停止できません。ダッシュボードから停止してください: ${holdWebLink(employee.id)}`);
  }
  const r = await startHold({ orgId: input.orgId, employeeId: employee.id, actor: { type: "member", member, surface: input.provider } });
  if (!r.ok) return refuse(r.code, r.message ?? `停止できませんでした（${r.code}）。ダッシュボード: ${holdWebLink(employee.id)}`);
  const head = r.created ? "緊急停止しました。" : r.upgraded ? "より強い停止に切り替えました。" : "すでに停止中です。";
  return { ok: true, code: r.created ? "stopped" : r.upgraded ? "upgraded" : "already_held",
    text: `${head}解除はダッシュボードからのみです（ログインし直して5分以内）: ${holdWebLink(employee.id)}` };
}
