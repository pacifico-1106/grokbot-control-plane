import { resolveApprovalWithWorkflow } from "@/lib/approvals/workflow-integration";
import { initializeWorkflowForApproval } from "@/lib/approval-workflow/resolve";
import { getMemberIdFromVoterBinding } from "@/lib/approval-workflow";
import { NextResponse } from "next/server";
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import {
  findAwaitingRevisionApproval,
  getApprovalByTelegramRef,
  getEmployee,
  getNotificationChannelByWebhookRef,
  getNotificationDelivery,
  resolveApproval,
  updateApprovalTelegramState,
} from "@/lib/data";
import { extraApproversAllow } from "@/lib/employees/approval-inbox";
import { isSelfApprovalDenied, SELF_APPROVAL_MESSAGE_JA } from "@/lib/admin-mcp/self-approval";
import {
  isAllowedLineSource,
  promptLineRevision,
  sendLineText,
  verifyLineSignature,
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

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const channel = await getNotificationChannelByWebhookRef("line", ref);
  if (!channel) return NextResponse.json({ ok: true, ignored: true });
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
    const source = event.source || {};
    // PR-B: the inbox bot joined a group / room (signature verified above) →
    // shared classification-proposal flow. The approval group itself is skipped.
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
    const userId = source.userId || "unknown";
    const actor = `line:${userId}`;

    if (event.type === "postback") {
      const match = /^(a|r|e):([A-Za-z0-9_-]{8,32})$/.exec(event.postback?.data || "");
      const approval = match ? await getApprovalByTelegramRef(match[2], channel.orgId) : null;
      const delivery = approval
        ? await getNotificationDelivery({ approvalId: approval.id, channelId: channel.id })
        : null;
      if (!match || !approval || !delivery || approval.status !== "pending") {
        if (event.replyToken) await sendLineText(channel, "対象は処理済みか見つかりません。", event.replyToken);
        continue;
      }
      const employeeForGate = await getEmployee(approval.employeeId, channel.orgId);
      if (!extraApproversAllow(userId, employeeForGate?.approverUserIds)) {
        if (event.replyToken) await sendLineText(channel, "この操作は許可されていません。", event.replyToken);
        continue;
      }
      if (match[1] === "e") {
        if ((await initializeWorkflowForApproval(approval, approval.employeeId || null)).instance) continue;
        if (event.replyToken) await promptLineRevision(approval, userId, event.replyToken, channel);
        continue;
      }
      const decision = match[1] === "a" ? "approved" : "rejected";
      // P0 Item 1: Look up member ID from voter binding for admin-class enforcement
      const memberId = await getMemberIdFromVoterBinding(channel.orgId, {
        provider: "line",
        channelKey: channel.id,
        userId,
      });
      try {
        const result = await resolveApprovalWithWorkflow(approval.id, decision, actor, channel.orgId, {
          decisionId: event.webhookEventId ? `line:${channel.id}:${event.webhookEventId}` : "",
          externalVoter: { provider: "line", channelKey: channel.id, userId },
          memberId,
        });
        const updated = result.ok && result.workflowComplete ? result.approval : null;
        if (updated) {
          await fulfillIfApproved(updated, decision);
          const employee = await getEmployee(updated.employeeId, channel.orgId);
          await runApprovalResolveSideEffects({ approval: updated, decision, actorEmail: actor, employee, surface: "line" });
        }
        if (event.replyToken) await sendLineText(channel, updated ? (decision === "approved" ? "承認しました。" : "却下しました。") : result.ok ? "投票を記録しました（合議は継続中です）。" : "投票を記録できませんでした。", event.replyToken);
      } catch (error) {
        if (isSelfApprovalDenied(error)) {
          if (event.replyToken) await sendLineText(channel, SELF_APPROVAL_MESSAGE_JA, event.replyToken);
        } else {
          throw error;
        }
      }
      continue;
    }

    if (event.type === "message" && event.message?.type === "text") {
      const note = event.message.text?.trim() || "";
      const approval = await findAwaitingRevisionApproval({
        orgId: channel.orgId,
        channelId: channel.id,
        provider: "line",
        userId,
      });
      if (!approval || !note) continue;
      if ((await initializeWorkflowForApproval(approval, approval.employeeId || null)).instance) continue;
      await updateApprovalTelegramState(approval, {
        awaitingRevisionFrom: null,
        awaitingRevisionChannelId: null,
        awaitingRevisionProvider: null,
      });
      // P0 Item 1: Look up member ID from voter binding for admin-class enforcement
      const revisionMemberId = await getMemberIdFromVoterBinding(channel.orgId, {
        provider: "line",
        channelKey: channel.id,
        userId,
      });
      try {
        const updated = await resolveApproval(approval.id, "revision_requested", actor, channel.orgId, {
          revisionNote: Array.from(note).slice(0, 2_000).join(""),
          memberId: revisionMemberId,
        });
        if (updated) {
          const employee = await getEmployee(updated.employeeId, channel.orgId);
          await runApprovalResolveSideEffects({ approval: updated, decision: "revision_requested", actorEmail: actor, employee, surface: "line" });
        }
        if (event.replyToken) await sendLineText(channel, updated ? "修正依頼を登録しました。" : "対象は処理済みです。", event.replyToken);
      } catch (error) {
        if (isSelfApprovalDenied(error)) {
          if (event.replyToken) await sendLineText(channel, SELF_APPROVAL_MESSAGE_JA, event.replyToken);
        } else {
          throw error;
        }
      }
    }
  }
  return NextResponse.json({ ok: true });
}
