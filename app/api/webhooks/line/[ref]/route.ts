import { resolveApprovalWithWorkflow } from "@/lib/approvals/workflow-integration";
import { initializeWorkflowForApproval } from "@/lib/approval-workflow/resolve";
import { getMemberIdFromVoterBinding } from "@/lib/approval-workflow";
import { upsertProofVerifiedVoterBinding } from "@/lib/approval-workflow/voter-binding";
import { NextResponse } from "next/server";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import {
  appendAuditEvent,
  findAwaitingRevisionApproval,
  getApprovalByTelegramRef,
  getEmployee,
  getMemberById,
  getNotificationChannelByWebhookRef,
  getNotificationDelivery,
  resolveApproval,
  updateApprovalTelegramState,
} from "@/lib/data";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import { lineApproverGate } from "@/lib/employees/approval-inbox";
import { isSelfApprovalDenied, SELF_APPROVAL_MESSAGE_JA } from "@/lib/admin-mcp/self-approval";
import {
  isLineApproverBindingMatchEnabled,
  isLineApproverLinkEnabled,
  isLineResolveFollowupReplyEnabled,
  isLineWorkflowRevisionReplyEnabled,
} from "@/lib/line/flags";
import { consumeLineLinkCode, parseLineLinkCodeText } from "@/lib/line/link-code";
import {
  isAllowedLineSource,
  promptLineRevision,
  sendLineReplyMessages,
  sendLineText,
  verifyLineSignature,
  withLineReplyCollector,
} from "@/lib/notify/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LineSource = { type?: string; userId?: string; groupId?: string; roomId?: string };
type LineEvent = {
  webhookEventId?: string;
  type?: string;
  replyToken?: string;
  source?: LineSource;
  postback?: { data?: string };
  message?: { type?: string; text?: string };
};

const MSG_NOT_FOUND = "対象は処理済みか見つかりません。";
const MSG_FORBIDDEN = "この操作は許可されていません。";
const MSG_NO_USER = "LINE のユーザーを確認できないため、この操作は処理できません。";
const MSG_WORKFLOW_REVISION =
  "この承認は複数人の承認（合議）で進んでいるため、LINE からの修正依頼は受け付けできません。［承認］か［却下］を選ぶか、Staffpass の承認画面で対応してください。";
const MSG_LINK_OK =
  "✅ この LINE アカウントを Staffpass の承認者として確認しました。Staffpass の設定画面に LINE ユーザー ID が表示されます。";
const MSG_LINK_INVALID =
  "連携コードが無効か、有効期限（15分）が切れています。Staffpass の設定画面で新しいコードを発行してください。";
const MSG_LINK_GROUP = "連携コードは、公式アカウントとの 1:1 トークで送ってください（グループでは受け付けません）。";
const MSG_LINK_ERROR = "連携コードを確認できませんでした。時間をおいて、もう一度お試しください。";

async function reply(channel: NotificationChannelRuntime, event: LineEvent, text: string) {
  if (event.replyToken) await sendLineText(channel, text, event.replyToken);
}

/**
 * Run a resolve step and answer with ONE Reply. With LINE_RESOLVE_FOLLOWUP_REPLY
 * ON, the "✅ 承認済み …" follow-up produced by side effects joins that Reply
 * instead of a separate Push; if the Reply fails, the follow-ups are pushed.
 */
async function resolveAndReply(
  channel: NotificationChannelRuntime,
  event: LineEvent,
  work: () => Promise<string | null>
) {
  if (!event.replyToken || !isLineResolveFollowupReplyEnabled()) {
    const ack = await work();
    if (ack) await reply(channel, event, ack);
    return;
  }
  const { result: ack, collected } = await withLineReplyCollector(channel.id, work);
  const texts = [ack, ...collected].filter((text): text is string => Boolean(text));
  if (texts.length === 0) return;
  const sent = await sendLineReplyMessages(channel, event.replyToken, texts);
  if (!sent.ok) {
    for (const text of collected) await sendLineText(channel, text);
  }
}

/**
 * G1/G4: redeem a one-time link code (flag ON only). Returns true when the event
 * was a link-code message, so it never falls through to revision handling.
 * Runs BEFORE the destination/allowedUserIds check on purpose: the sender is
 * typically not registered yet. Trust comes from the code, not from the sender.
 */
async function handleLinkCode(channel: NotificationChannelRuntime, event: LineEvent): Promise<boolean> {
  if (event.type !== "message" || event.message?.type !== "text") return false;
  const code = parseLineLinkCodeText(event.message.text);
  if (!code) return false;
  const source = event.source || {};
  const lineUserId = source.userId || "";
  if (source.type !== "user" || source.groupId || source.roomId || !lineUserId) {
    await reply(channel, event, MSG_LINK_GROUP);
    return true;
  }
  const consumed = await consumeLineLinkCode({
    orgId: channel.orgId,
    channelId: channel.id,
    code,
    lineUserId,
  });
  if (!consumed.ok) {
    await reply(channel, event, consumed.reason === "invalid_or_expired" ? MSG_LINK_INVALID : MSG_LINK_ERROR);
    if (consumed.reason !== "invalid_or_expired") {
      console.error("line_link_code_consume_failed", { channelId: channel.id, reason: consumed.reason });
    }
    return true;
  }
  const bound = await upsertProofVerifiedVoterBinding({
    orgId: channel.orgId,
    provider: "line",
    channelKey: channel.id,
    externalUserId: lineUserId,
    memberId: consumed.memberId,
  });
  await appendAuditEvent({
    orgId: channel.orgId,
    employeeId: null,
    credentialId: null,
    action: "notification.channel_updated",
    purpose: null,
    summary: bound.ok
      ? "LINE 承認者の本人確認（連携コード）が完了"
      : `LINE 承認者の本人確認（連携コード）に失敗: ${bound.reason}`,
    metadata: {
      event: bound.ok ? "line_approver_linked" : "line_approver_link_failed",
      provider: "line",
      channelId: channel.id,
      memberId: consumed.memberId,
      lineUserId,
      ...(bound.ok ? {} : { reason: bound.reason }),
    },
  }).catch(() => undefined);
  await reply(channel, event, bound.ok ? MSG_LINK_OK : bound.messageJa);
  return true;
}

async function boundMemberFor(channel: NotificationChannelRuntime, lineUserId: string) {
  const memberId = await getMemberIdFromVoterBinding(channel.orgId, {
    provider: "line",
    channelKey: channel.id,
    userId: lineUserId,
  });
  if (!memberId) return { memberId: null, binding: null };
  if (!isLineApproverBindingMatchEnabled()) return { memberId, binding: null };
  const member = await getMemberById(memberId, channel.orgId);
  if (!member || member.orgId !== channel.orgId || member.status !== "active") {
    return { memberId, binding: null };
  }
  return { memberId, binding: { memberId, memberUserId: member.userId ?? null } };
}

async function handlePostback(channel: NotificationChannelRuntime, event: LineEvent, lineUserId: string) {
  const match = /^(a|r|e):([A-Za-z0-9_-]{8,32})$/.exec(event.postback?.data || "");
  const approval = match ? await getApprovalByTelegramRef(match[2], channel.orgId) : null;
  const delivery = approval
    ? await getNotificationDelivery({ approvalId: approval.id, channelId: channel.id })
    : null;
  if (!match || !approval || !delivery || approval.status !== "pending") {
    await reply(channel, event, MSG_NOT_FOUND);
    return;
  }
  const employeeForGate = approval.employeeId ? await getEmployee(approval.employeeId, channel.orgId) : null;
  const { memberId, binding } = lineUserId
    ? await boundMemberFor(channel, lineUserId)
    : { memberId: null, binding: null };
  const gate = lineApproverGate({
    lineUserId,
    approvalEmployeeId: approval.employeeId,
    employee: employeeForGate,
    binding,
    bindingMatch: isLineApproverBindingMatchEnabled(),
  });
  if (!gate.allowed) {
    await reply(channel, event, gate.reason === "missing_user_id" ? MSG_NO_USER : MSG_FORBIDDEN);
    return;
  }
  if (match[1] === "e") {
    if ((await initializeWorkflowForApproval(approval, approval.employeeId || null)).instance) {
      // G5: workflows do not support revision requests (workflow-integration
      // returns revision_not_supported_in_workflow); say so instead of silence.
      if (isLineWorkflowRevisionReplyEnabled()) await reply(channel, event, MSG_WORKFLOW_REVISION);
      return;
    }
    if (event.replyToken) await promptLineRevision(approval, lineUserId, event.replyToken, channel);
    return;
  }
  const decision = match[1] === "a" ? "approved" : "rejected";
  const actor = `line:${lineUserId}`;
  await resolveAndReply(channel, event, async () => {
    try {
      const result = await resolveApprovalWithWorkflow(approval.id, decision, actor, channel.orgId, {
        decisionId: event.webhookEventId ? `line:${channel.id}:${event.webhookEventId}` : "",
        externalVoter: { provider: "line", channelKey: channel.id, userId: lineUserId },
        memberId,
      });
      const updated = result.ok && result.workflowComplete ? result.approval : null;
      if (updated) {
        await fulfillIfApproved(updated, decision);
        const employee = await getEmployee(updated.employeeId, channel.orgId);
        await runApprovalResolveSideEffects({ approval: updated, decision, actorEmail: actor, employee });
      }
      return updated
        ? decision === "approved" ? "承認しました。" : "却下しました。"
        : result.ok ? "投票を記録しました（合議は継続中です）。" : "投票を記録できませんでした。";
    } catch (error) {
      if (isSelfApprovalDenied(error)) return SELF_APPROVAL_MESSAGE_JA;
      throw error;
    }
  });
}

async function handleRevisionText(channel: NotificationChannelRuntime, event: LineEvent, lineUserId: string) {
  if (!lineUserId) return;
  const note = event.message?.text?.trim() || "";
  const approval = await findAwaitingRevisionApproval({
    orgId: channel.orgId,
    channelId: channel.id,
    provider: "line",
    userId: lineUserId,
  });
  if (!approval || !note) return;
  if ((await initializeWorkflowForApproval(approval, approval.employeeId || null)).instance) {
    if (isLineWorkflowRevisionReplyEnabled()) {
      await updateApprovalTelegramState(approval, {
        awaitingRevisionFrom: null,
        awaitingRevisionChannelId: null,
        awaitingRevisionProvider: null,
      });
      await reply(channel, event, MSG_WORKFLOW_REVISION);
    }
    return;
  }
  await updateApprovalTelegramState(approval, {
    awaitingRevisionFrom: null,
    awaitingRevisionChannelId: null,
    awaitingRevisionProvider: null,
  });
  // P0 Item 1: Look up member ID from voter binding for admin-class enforcement
  const revisionMemberId = await getMemberIdFromVoterBinding(channel.orgId, {
    provider: "line",
    channelKey: channel.id,
    userId: lineUserId,
  });
  const actor = `line:${lineUserId}`;
  await resolveAndReply(channel, event, async () => {
    try {
      const updated = await resolveApproval(approval.id, "revision_requested", actor, channel.orgId, {
        revisionNote: Array.from(note).slice(0, 2_000).join(""),
        memberId: revisionMemberId,
      });
      if (updated) {
        const employee = await getEmployee(updated.employeeId, channel.orgId);
        await runApprovalResolveSideEffects({ approval: updated, decision: "revision_requested", actorEmail: actor, employee });
      }
      return updated ? "修正依頼を登録しました。" : "対象は処理済みです。";
    } catch (error) {
      if (isSelfApprovalDenied(error)) return SELF_APPROVAL_MESSAGE_JA;
      throw error;
    }
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const channel = await getNotificationChannelByWebhookRef("line", ref);
  // G3: an unknown or disabled ref is a wrong Webhook URL. Answer non-2xx so the
  // LINE Developers「検証」button fails instead of reporting success. The body is
  // not read and no channel data is revealed.
  if (!channel) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const rawBody = await req.text();
  if (!verifyLineSignature(channel, rawBody, req.headers.get("x-line-signature") || "")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: { events?: LineEvent[] };
  try {
    body = JSON.parse(rawBody || "{}") as { events?: LineEvent[] };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  for (const event of body.events || []) {
    if (isLineApproverLinkEnabled() && (await handleLinkCode(channel, event))) continue;
    const source = event.source || {};
    if (!isAllowedLineSource(channel, source)) continue;
    const lineUserId = source.userId || "";
    if (event.type === "postback") {
      await handlePostback(channel, event, lineUserId);
      continue;
    }
    if (event.type === "message" && event.message?.type === "text") {
      await handleRevisionText(channel, event, lineUserId);
    }
  }
  return NextResponse.json({ ok: true });
}
