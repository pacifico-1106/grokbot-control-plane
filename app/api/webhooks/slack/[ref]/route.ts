import { NextResponse } from "next/server";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import {
  getApprovalByTelegramRef,
  getEmployee,
  getNotificationChannelByWebhookRef,
  getNotificationDelivery,
  resolveApproval,
} from "@/lib/data";
import { extraApproversAllow } from "@/lib/employees/approval-inbox";
import { verifySlackSignature } from "@/lib/notify/slack";
import { isSelfApprovalDenied } from "@/lib/admin-mcp/self-approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SlackUser = { id?: string };
type SlackChannel = { id?: string };
type SlackAction = { action_id?: string; value?: string; type?: string };
type SlackPayload = {
  type?: string;
  challenge?: string;
  user?: SlackUser;
  channel?: SlackChannel;
  container?: { message_ts?: string; channel_id?: string };
  message?: { ts?: string };
  actions?: SlackAction[];
  response_url?: string;
};

function ack(extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...extra });
}

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const channel = await getNotificationChannelByWebhookRef("slack", ref);
  if (!channel) return ack({ ignored: true });

  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") || "";
  const signature = req.headers.get("x-slack-signature") || "";
  if (
    !verifySlackSignature({
      signingSecret: channel.secrets.signingSecret || "",
      timestamp,
      rawBody,
      signature,
    })
  ) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") || "";
  let payload: SlackPayload = {};
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(rawBody);
      payload = JSON.parse(params.get("payload") || "{}") as SlackPayload;
    } else {
      payload = JSON.parse(rawBody || "{}") as SlackPayload;
    }
  } catch {
    return ack();
  }

  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }
  if (payload.type !== "block_actions") return ack();

  try {
    await handleBlockActions(channel, payload);
  } catch (error) {
    console.error("slack_webhook_handle_failed", error);
  }
  return ack();
}

async function handleBlockActions(
  channel: NonNullable<Awaited<ReturnType<typeof getNotificationChannelByWebhookRef>>>,
  payload: SlackPayload
) {
  const userId = payload.user?.id || "";
  const slackChannel = payload.channel?.id || payload.container?.channel_id || "";
  const ts = payload.message?.ts || payload.container?.message_ts || "";
  const allowed = Array.isArray(channel.config.allowedUserIds)
    ? channel.config.allowedUserIds.map(String)
    : [];
  if (allowed.length > 0 && (!userId || !allowed.includes(userId))) {
    return;
  }

  const action = (payload.actions || []).find((item) =>
    ["staffpass_approve", "staffpass_reject", "staffpass_revise"].includes(item.action_id || "")
  );
  if (!action?.action_id || !action.value || !ts || !slackChannel) return;

  const approval = await getApprovalByTelegramRef(action.value);
  if (!approval || approval.orgId !== channel.orgId || approval.status !== "pending") return;
  const delivery = await getNotificationDelivery({
    approvalId: approval.id,
    channelId: channel.id,
  });
  const deliveryChannel = String(delivery?.context.channel || "");
  if (
    !delivery ||
    delivery.externalMessageId !== ts ||
    (deliveryChannel && deliveryChannel !== slackChannel)
  ) {
    return;
  }

  const employeeForGate = await getEmployee(approval.employeeId, channel.orgId);
  if (!extraApproversAllow(userId, employeeForGate?.approverUserIds)) return;

  const actor = `slack:${userId || "unknown"}`;
  try {
    if (action.action_id === "staffpass_revise") {
      const updated = await resolveApproval(
        approval.id,
        "revision_requested",
        actor,
        channel.orgId,
        { revisionNote: "Slackから修正依頼" }
      );
      if (updated) {
        const employee = await getEmployee(updated.employeeId, channel.orgId);
        await runApprovalResolveSideEffects({
          approval: updated,
          decision: "revision_requested",
          actorEmail: actor,
          employee,
        });
      }
      return;
    }

    const decision = action.action_id === "staffpass_approve" ? "approved" : "rejected";
    const updated = await resolveApproval(approval.id, decision, actor, channel.orgId);
    if (updated) {
      await fulfillIfApproved(updated, decision);
      const employee = await getEmployee(updated.employeeId, channel.orgId);
      await runApprovalResolveSideEffects({
        approval: updated,
        decision,
        actorEmail: actor,
        employee,
      });
    }
  } catch (error) {
    if (isSelfApprovalDenied(error)) return;
    throw error;
  }
}
