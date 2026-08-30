import { NextResponse } from "next/server";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import {
  getApprovalById,
  getApprovalByTelegramRef,
  getApprovalIdByDeliveryExternal,
  getEmployee,
  getNotificationChannelByWebhookRef,
  getNotificationDelivery,
  resolveApproval,
  updateApprovalTelegramState,
} from "@/lib/data";
import {
  answerTelegramCallbackForChannel,
  promptTelegramRevisionForChannel,
  sendTelegramTextToChannel,
  telegramTargetFromChannel,
} from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TgUser = { id?: number };
type TgMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number };
  from?: TgUser;
  reply_to_message?: { message_id?: number };
};
type TgUpdate = {
  message?: TgMessage;
  callback_query?: { id?: string; data?: string; from?: TgUser; message?: TgMessage };
};

function allowed(channel: NonNullable<Awaited<ReturnType<typeof getNotificationChannelByWebhookRef>>>, message?: TgMessage, user?: TgUser) {
  const target = telegramTargetFromChannel(channel);
  if (!target || String(message?.chat?.id ?? "") !== target.chatId || !Number.isSafeInteger(user?.id)) return false;
  return !target.allowedUserIds?.length || target.allowedUserIds.includes(String(user!.id));
}

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const channel = await getNotificationChannelByWebhookRef("telegram", ref);
  if (!channel) return NextResponse.json({ ok: true, ignored: true });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== channel.secrets.webhookSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const update = (await req.json().catch(() => ({}))) as TgUpdate;
  const query = update.callback_query;
  if (query) {
    if (!allowed(channel, query.message, query.from)) {
      await answerTelegramCallbackForChannel(channel, query.id || "", "この操作は許可されていません");
      return NextResponse.json({ ok: true, ignored: true });
    }
    const match = /^(a|r|e):([A-Za-z0-9_-]{8,32})$/.exec(query.data || "");
    const approval = match ? await getApprovalByTelegramRef(match[2]) : null;
    const delivery = approval ? await getNotificationDelivery({ approvalId: approval.id, channelId: channel.id }) : null;
    if (!match || !approval || approval.orgId !== channel.orgId || approval.status !== "pending" || delivery?.externalMessageId !== String(query.message?.message_id ?? "")) {
      await answerTelegramCallbackForChannel(channel, query.id || "", "対象は処理済みか見つかりません");
      return NextResponse.json({ ok: true });
    }
    const employeeForGate = await getEmployee(approval.employeeId, channel.orgId);
    const extraApprovers = employeeForGate?.approverUserIds ?? [];
    if (extraApprovers.length && !extraApprovers.includes(String(query.from!.id))) {
      await answerTelegramCallbackForChannel(channel, query.id || "", "この操作は許可されていません");
      return NextResponse.json({ ok: true, ignored: true });
    }
    if (match[1] === "e") {
      const result = await promptTelegramRevisionForChannel(approval, query.from!.id!, channel);
      await answerTelegramCallbackForChannel(channel, query.id || "", result.ok ? "返信で修正指示を送ってください" : "処理に失敗しました");
      return NextResponse.json({ ok: true });
    }
    const decision = match[1] === "a" ? "approved" : "rejected";
    const actor = `telegram:${query.from!.id}`;
    const updated = await resolveApproval(approval.id, decision, actor, channel.orgId);
    if (updated) {
      await fulfillIfApproved(updated, decision);
      const employee = await getEmployee(updated.employeeId, channel.orgId);
      await runApprovalResolveSideEffects({ approval: updated, decision, actorEmail: actor, employee });
    }
    await answerTelegramCallbackForChannel(channel, query.id || "", updated ? (decision === "approved" ? "承認しました" : "却下しました") : "対象は処理済みです");
    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message || !allowed(channel, message, message.from)) return NextResponse.json({ ok: true, ignored: true });
  const replyTo = Number(message.reply_to_message?.message_id);
  const note = message.text?.trim() || "";
  if (!Number.isSafeInteger(replyTo) || !note) return NextResponse.json({ ok: true });
  const approvalId = await getApprovalIdByDeliveryExternal({ channelId: channel.id, externalMessageId: String(replyTo) });
  const approval = approvalId ? await getApprovalById(approvalId, channel.orgId) : null;
  if (!approval || approval.status !== "pending" || String(approval.metadata.awaiting_revision_from ?? "") !== String(message.from?.id) || approval.metadata.awaiting_revision_channel_id !== channel.id) {
    await sendTelegramTextToChannel(channel, "対象が見つかりません", message.message_id);
    return NextResponse.json({ ok: true });
  }
  await updateApprovalTelegramState(approval, {
    awaitingRevisionFrom: null,
    awaitingRevisionChannelId: null,
    awaitingRevisionProvider: null,
  });
  const actor = `telegram:${message.from!.id}`;
  const updated = await resolveApproval(approval.id, "revision_requested", actor, channel.orgId, { revisionNote: note.slice(0, 2_000) });
  if (updated) {
    const employee = await getEmployee(updated.employeeId, channel.orgId);
    await runApprovalResolveSideEffects({ approval: updated, decision: "revision_requested", actorEmail: actor, employee });
  }
  return NextResponse.json({ ok: true });
}
