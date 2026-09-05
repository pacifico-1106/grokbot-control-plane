import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import {
  getApprovalById,
  getApprovalByTelegramRef,
  getApprovalIdByDeliveryExternal,
  getEmployee,
  getNotificationDelivery,
  resolveApproval,
  updateApprovalTelegramState,
  type NotificationChannelRuntime,
} from "@/lib/data";
import { extraApproversAllow } from "@/lib/employees/approval-inbox";
import { isSelfApprovalDenied, SELF_APPROVAL_MESSAGE_JA } from "@/lib/admin-mcp/self-approval";
import {
  answerTelegramCallbackForChannel,
  promptTelegramRevisionForChannel,
  sendTelegramTextToChannel,
  telegramTargetFromChannel,
} from "@/lib/notify/telegram";

export type TelegramChannelUpdate = {
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number };
    from?: { id?: number };
    reply_to_message?: { message_id?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: {
      message_id?: number;
      chat?: { id?: number };
      from?: { id?: number };
    };
  };
};

export type TelegramChannelHandleResult = {
  processed: boolean;
  ignored?: boolean;
};

function allowed(
  channel: NotificationChannelRuntime,
  message?: TelegramChannelUpdate["message"],
  user?: { id?: number }
) {
  const target = telegramTargetFromChannel(channel);
  if (!target || String(message?.chat?.id ?? "") !== target.chatId || !Number.isSafeInteger(user?.id)) {
    return false;
  }
  return !target.allowedUserIds?.length || target.allowedUserIds.includes(String(user!.id));
}

/**
 * Tenant-inbox approve/reject/revise (delivery match + extraApproversAllow).
 * When fallbackOnMiss is set, a delivery miss returns processed:false so the
 * global env-chat path can still handle in-flight 安藤 cards.
 */
export async function handleTelegramChannelUpdate(
  channel: NotificationChannelRuntime,
  update: TelegramChannelUpdate,
  opts?: { fallbackOnMiss?: boolean }
): Promise<TelegramChannelHandleResult> {
  const query = update.callback_query;
  if (query) {
    if (!allowed(channel, query.message, query.from)) {
      await answerTelegramCallbackForChannel(channel, query.id || "", "この操作は許可されていません");
      return { processed: true, ignored: true };
    }
    const match = /^(a|r|e):([A-Za-z0-9_-]{8,32})$/.exec(query.data || "");
    const approval = match ? await getApprovalByTelegramRef(match[2], channel.orgId) : null;
    const delivery = approval
      ? await getNotificationDelivery({ approvalId: approval.id, channelId: channel.id })
      : null;
    const deliveryOk =
      Boolean(match) &&
      Boolean(approval) &&
      approval!.status === "pending" &&
      delivery?.externalMessageId === String(query.message?.message_id ?? "");
    if (!deliveryOk) {
      if (opts?.fallbackOnMiss) return { processed: false };
      await answerTelegramCallbackForChannel(channel, query.id || "", "対象は処理済みか見つかりません");
      return { processed: true };
    }
    const employeeForGate = await getEmployee(approval!.employeeId, channel.orgId);
    if (!extraApproversAllow(query.from?.id, employeeForGate?.approverUserIds)) {
      await answerTelegramCallbackForChannel(channel, query.id || "", "この操作は許可されていません");
      return { processed: true, ignored: true };
    }
    if (match![1] === "e") {
      const result = await promptTelegramRevisionForChannel(approval!, query.from!.id!, channel);
      await answerTelegramCallbackForChannel(
        channel,
        query.id || "",
        result.ok ? "返信で修正指示を送ってください" : "処理に失敗しました"
      );
      return { processed: true };
    }
    const decision = match![1] === "a" ? "approved" : "rejected";
    const actor = `telegram:${query.from!.id}`;
    try {
      const updated = await resolveApproval(approval!.id, decision, actor, channel.orgId);
      if (updated) {
        await fulfillIfApproved(updated, decision);
        const employee = await getEmployee(updated.employeeId, channel.orgId);
        await runApprovalResolveSideEffects({ approval: updated, decision, actorEmail: actor, employee });
      }
      await answerTelegramCallbackForChannel(
        channel,
        query.id || "",
        updated ? (decision === "approved" ? "承認しました" : "却下しました") : "対象は処理済みです"
      );
    } catch (error) {
      if (isSelfApprovalDenied(error)) {
        await answerTelegramCallbackForChannel(channel, query.id || "", SELF_APPROVAL_MESSAGE_JA);
      } else {
        throw error;
      }
    }
    return { processed: true };
  }

  const message = update.message;
  if (!message || !allowed(channel, message, message.from)) {
    return { processed: true, ignored: true };
  }
  const replyTo = Number(message.reply_to_message?.message_id);
  const note = message.text?.trim() || "";
  if (!Number.isSafeInteger(replyTo) || !note) return { processed: true };
  const approvalId = await getApprovalIdByDeliveryExternal({
    channelId: channel.id,
    externalMessageId: String(replyTo),
  });
  const approval = approvalId ? await getApprovalById(approvalId, channel.orgId) : null;
  if (
    !approval ||
    approval.status !== "pending" ||
    String(approval.metadata.awaiting_revision_from ?? "") !== String(message.from?.id) ||
    approval.metadata.awaiting_revision_channel_id !== channel.id
  ) {
    if (opts?.fallbackOnMiss) return { processed: false };
    await sendTelegramTextToChannel(channel, "対象が見つかりません", message.message_id);
    return { processed: true };
  }
  await updateApprovalTelegramState(approval, {
    awaitingRevisionFrom: null,
    awaitingRevisionChannelId: null,
    awaitingRevisionProvider: null,
  });
  const actor = `telegram:${message.from!.id}`;
  try {
    const updated = await resolveApproval(approval.id, "revision_requested", actor, channel.orgId, {
      revisionNote: note.slice(0, 2_000),
    });
    if (updated) {
      const employee = await getEmployee(updated.employeeId, channel.orgId);
      await runApprovalResolveSideEffects({
        approval: updated,
        decision: "revision_requested",
        actorEmail: actor,
        employee,
      });
    }
  } catch (error) {
    if (isSelfApprovalDenied(error)) {
      await sendTelegramTextToChannel(channel, SELF_APPROVAL_MESSAGE_JA, message.message_id);
      return { processed: true };
    }
    throw error;
  }
  return { processed: true };
}
