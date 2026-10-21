/**
 * LINE approval event loop (postback / link code / revision / inbox stop).
 * Used by POST /api/webhooks/line/<ref> and, for the same OA (U-06), by
 * POST /api/webhooks/line/c/<ref> after the conversation account signature.
 */
import { approverAuthorityReplyJa } from "@/lib/approver-authority/reply";
import { resolveApprovalWithWorkflow } from "@/lib/approvals/workflow-integration";
import { initializeWorkflowForApproval } from "@/lib/approval-workflow/resolve";
import { getMemberIdFromVoterBinding } from "@/lib/approval-workflow";
import { upsertProofVerifiedVoterBinding } from "@/lib/approval-workflow/voter-binding";
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import {
  appendAuditEvent,
  findAwaitingRevisionApproval,
  getApprovalByTelegramRef,
  getEmployee,
  getMemberById,
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
import { parseLineLinkCodeText } from "@/lib/line/link-code";
import { redeemLineLinkCode } from "@/lib/line/link-code-limits";
import {
  isAllowedLineSource,
  promptLineRevision,
  sendLineReplyMessages,
  sendLineText,
  withLineReplyCollector,
} from "@/lib/notify/line";
import {
  LINE_APPROVER_LINK_ERROR_JA,
  LINE_APPROVER_LINK_FAIL_JA,
  LINE_APPROVER_LINK_GROUP_JA,
  LINE_APPROVER_LINK_INVALID_JA,
  LINE_APPROVER_LINK_OK_JA,
  LINE_WEB_ONLY_APPROVE_JA_OF,
  LINE_WEB_ONLY_APPROVE_PATH,
} from "@/lib/comm/line-poc-copy";
import { isLineWebOnlyHighRiskEnabled } from "@/lib/comm/flags";
import { lineWebOnlyHighRiskVerdict } from "@/lib/comm/line-web-only-high-risk";
import { isLineLinkCodeLimitsEnabled } from "@/lib/line/link-code-limits";
import { getAppOrigin } from "@/lib/approvals/tokens";

export type LineApprovalSource = { type?: string; userId?: string; groupId?: string; roomId?: string };
export type LineApprovalEvent = {
  webhookEventId?: string;
  type?: string;
  replyToken?: string;
  source?: LineApprovalSource;
  postback?: { data?: string };
  message?: { type?: string; text?: string };
};

const MSG_NOT_FOUND = "対象は処理済みか見つかりません。";
const MSG_FORBIDDEN = "この操作は許可されていません。";
const MSG_NO_USER = "LINE のユーザーを確認できないため、この操作は処理できません。";
const MSG_WORKFLOW_REVISION =
  "この承認は複数人の承認（合議）で進んでいるため、LINE からの修正依頼は受け付けできません。［承認］か［却下］を選ぶか、Staffpass の承認画面で対応してください。";
const MSG_LINK_OK = LINE_APPROVER_LINK_OK_JA;
const MSG_LINK_INVALID = LINE_APPROVER_LINK_INVALID_JA;
const MSG_LINK_GROUP = LINE_APPROVER_LINK_GROUP_JA;
const MSG_LINK_ERROR = LINE_APPROVER_LINK_ERROR_JA;

async function reply(channel: NotificationChannelRuntime, event: LineApprovalEvent, text: string) {
  if (event.replyToken) await sendLineText(channel, text, event.replyToken);
}

async function resolveAndReply(
  channel: NotificationChannelRuntime,
  event: LineApprovalEvent,
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
 */
export async function handleLineApproverLinkCode(
  channel: NotificationChannelRuntime,
  event: LineApprovalEvent
): Promise<boolean> {
  if (event.type !== "message" || event.message?.type !== "text") return false;
  const code = parseLineLinkCodeText(event.message.text);
  if (!code) return false;
  const source = event.source || {};
  const lineUserId = source.userId || "";
  if (source.type !== "user" || source.groupId || source.roomId || !lineUserId) {
    await reply(channel, event, MSG_LINK_GROUP);
    return true;
  }
  const consumed = await redeemLineLinkCode({
    orgId: channel.orgId,
    channelId: channel.id,
    code,
    lineUserId,
  });
  if (!consumed.ok) {
    // L1: flag ON → one opaque fail (same as conversation). Flag OFF keeps
    // production approver copy (invalid vs error vs replyJa).
    const failJa = isLineLinkCodeLimitsEnabled()
      ? LINE_APPROVER_LINK_FAIL_JA
      : consumed.replyJa ?? (consumed.reason === "invalid_or_expired" ? MSG_LINK_INVALID : MSG_LINK_ERROR);
    await reply(channel, event, failJa);
    if (consumed.reason !== "invalid_or_expired" && consumed.reason !== "sender_locked" && consumed.reason !== "account_locked") {
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
  await reply(
    channel,
    event,
    bound.ok
      ? MSG_LINK_OK
      : isLineLinkCodeLimitsEnabled()
        ? LINE_APPROVER_LINK_FAIL_JA
        : bound.messageJa
  );
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

async function handlePostback(channel: NotificationChannelRuntime, event: LineApprovalEvent, lineUserId: string) {
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
  if (match[1] === "a" && isLineWebOnlyHighRiskEnabled(channel.orgId)) {
    const verdict = lineWebOnlyHighRiskVerdict(approval);
    if (verdict.refuse) {
      try {
        await appendAuditEvent({
          orgId: channel.orgId,
          employeeId: approval.employeeId,
          credentialId: null,
          action: "line.web_only_refused",
          purpose: approval.purpose ?? null,
          summary: "LINE postback refused high-risk approval (web only until passkeys)",
          metadata: {
            event: "line_web_only_high_risk",
            approvalId: approval.id,
            reason: verdict.reason,
            category: verdict.category,
            webPath: LINE_WEB_ONLY_APPROVE_PATH,
          },
        });
      } catch (err) {
        console.error("line_web_only_refused_audit_failed", {
          orgId: channel.orgId,
          approvalId: approval.id,
          reason: verdict.reason,
          err,
        });
      }
      await reply(
        channel,
        event,
        LINE_WEB_ONLY_APPROVE_JA_OF(`${getAppOrigin()}${LINE_WEB_ONLY_APPROVE_PATH}`)
      );
      return;
    }
  }
  if (match[1] === "e") {
    if ((await initializeWorkflowForApproval(approval, approval.employeeId || null)).instance) {
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
        await runApprovalResolveSideEffects({ approval: updated, decision, actorEmail: actor, employee, surface: "line" });
      }
      return updated
        ? decision === "approved" ? "承認しました。" : "却下しました。"
        : approverAuthorityReplyJa(result.reason) ?? (result.ok ? "投票を記録しました（合議は継続中です）。" : "投票を記録できませんでした。");
    } catch (error) {
      if (isSelfApprovalDenied(error)) return SELF_APPROVAL_MESSAGE_JA;
      throw error;
    }
  });
}

/** Returns true when an awaiting-revision ticket consumed this 1:1 text. */
export async function tryHandleLineRevisionText(
  channel: NotificationChannelRuntime,
  event: LineApprovalEvent,
  lineUserId: string
): Promise<boolean> {
  if (!lineUserId) return false;
  const note = event.message?.text?.trim() || "";
  const approval = await findAwaitingRevisionApproval({
    orgId: channel.orgId,
    channelId: channel.id,
    provider: "line",
    userId: lineUserId,
  });
  if (!approval || !note) return false;
  if ((await initializeWorkflowForApproval(approval, approval.employeeId || null)).instance) {
    if (isLineWorkflowRevisionReplyEnabled()) {
      await updateApprovalTelegramState(approval, {
        awaitingRevisionFrom: null,
        awaitingRevisionChannelId: null,
        awaitingRevisionProvider: null,
      });
      await reply(channel, event, MSG_WORKFLOW_REVISION);
    }
    return true;
  }
  await updateApprovalTelegramState(approval, {
    awaitingRevisionFrom: null,
    awaitingRevisionChannelId: null,
    awaitingRevisionProvider: null,
  });
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
        await runApprovalResolveSideEffects({ approval: updated, decision: "revision_requested", actorEmail: actor, employee, surface: "line" });
      }
      return updated ? "修正依頼を登録しました。" : "対象は処理済みです。";
    } catch (error) {
      if (isSelfApprovalDenied(error)) return SELF_APPROVAL_MESSAGE_JA;
      throw error;
    }
  });
  return true;
}

export async function handleLineApprovalEvents(
  channel: NotificationChannelRuntime,
  events: LineApprovalEvent[]
): Promise<void> {
  for (const event of events) {
    if (isLineApproverLinkEnabled() && (await handleLineApproverLinkCode(channel, event))) continue;
    const source = event.source || {};
    if (event.type === "join" && isChannelClassifyProposalsEnabled()) {
      const destinationId = String((channel.config as Record<string, unknown>)?.destinationId || "");
      const joinedId = source.groupId || source.roomId || "";
      if (joinedId && joinedId !== destinationId) {
        const { lineJoinSignal, handleChannelJoin } = await import("@/lib/channel-classify/join");
        const signal = lineJoinSignal({ orgId: channel.orgId }, event);
        if (signal) await handleChannelJoin(signal);
      }
      continue;
    }
    if (!isAllowedLineSource(channel, source)) continue;
    const lineUserId = source.userId || "";
    if (event.type === "postback") {
      const stopMatch = /^s:([A-Za-z0-9_-]{8,32})$/.exec(event.postback?.data || "");
      if (stopMatch) {
        if (!lineUserId) {
          await reply(channel, event, MSG_NO_USER);
          continue;
        }
        const { stopFromInbox } = await import("@/lib/safety/hold-inbox");
        const r = await stopFromInbox({ orgId: channel.orgId, provider: "line", channelId: channel.id, userId: lineUserId, ref: stopMatch[1] });
        await reply(channel, event, r.text);
        continue;
      }
      await handlePostback(channel, event, lineUserId);
      continue;
    }
    if (event.type === "message" && event.message?.type === "text") {
      await tryHandleLineRevisionText(channel, event, lineUserId);
    }
  }
}
