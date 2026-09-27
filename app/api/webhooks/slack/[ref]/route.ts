import { createHash } from "node:crypto";
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
import { isSlackApprovalStrict } from "@/lib/feature-flags";
import { isSlackUserFromExpectedTeam } from "@/lib/slack/channel-validation";
import { checkSlackVoterBinding } from "@/lib/approval-workflow/slack-voter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SlackUser = { id?: string; team_id?: string };
type SlackTeam = { id?: string };
type SlackChannel = { id?: string };
type SlackAction = { action_id?: string; value?: string; type?: string };
type SlackPayload = {
  type?: string;
  challenge?: string;
  user?: SlackUser;
  team?: SlackTeam;
  channel?: SlackChannel;
  container?: { message_ts?: string; channel_id?: string };
  message?: { ts?: string };
  actions?: SlackAction[];
  response_url?: string;
};

function ack(extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...extra });
}

/**
 * Item 9: Send an ephemeral message to the button presser with the rejection reason.
 * No secrets are exposed in the message - only the reason code is shown.
 */
async function sendEphemeralRejection(responseUrl: string | undefined, reason: string): Promise<void> {
  if (!responseUrl) return;
  const REJECTION_MESSAGES: Record<string, string> = {
    expected_team_id_not_configured: "このチャンネルは厳格モードで構成されていますが、予期されるチームIDが設定されていません。管理者にお問い合わせください。",
    user_team_id_missing: "あなたのチームIDを取得できませんでした。",
    external_team_user: "外部ワークスペースのユーザーはこの承認ボタンを使用できません。",
    not_in_voter_binding: "あなたはこの承認の投票者として登録されていません。",
    not_in_allowed_list: "あなたはこのチャンネルの許可されたユーザーリストに含まれていません。",
    no_voter_binding_configured: "投票者バインディングが構成されていません。管理者にお問い合わせください。",
  };
  const message = REJECTION_MESSAGES[reason] || `承認ボタンの操作が拒否されました: ${reason}`;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: false,
        text: `⚠️ ${message}`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error("slack_ephemeral_rejection_failed", error);
  }
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
    await handleBlockActions(channel, payload, `slack:${channel.id}:${createHash("sha256").update(rawBody).digest("hex")}`);
  } catch (error) {
    console.error("slack_webhook_handle_failed", error);
  }
  return ack();
}

async function handleBlockActions(
  channel: NonNullable<Awaited<ReturnType<typeof getNotificationChannelByWebhookRef>>>,
  payload: SlackPayload,
  decisionId: string
) {
  const userId = payload.user?.id || "";
  const userTeamId = payload.user?.team_id || payload.team?.id || "";
  const slackChannel = payload.channel?.id || payload.container?.channel_id || "";
  const ts = payload.message?.ts || payload.container?.message_ts || "";
  const allowed = Array.isArray(channel.config.allowedUserIds)
    ? channel.config.allowedUserIds.map(String)
    : [];

  const strictMode = isSlackApprovalStrict();

  // P0 Item 5: When strict mode is ON, verify team_id matches expected team
  // This prevents external-org users (Slack Connect) from pressing approval buttons
  // Item 8: When strict mode is ON, missing expectedTeamId FAILS CLOSED (not allowed)
  if (strictMode) {
    const expectedTeamId = String(channel.config.expectedTeamId || "").trim();
    const teamCheck = isSlackUserFromExpectedTeam(userTeamId, expectedTeamId, true /* strictMode */);
    if (!teamCheck.allowed) {
      console.warn("slack_approval_team_mismatch", {
        channelId: channel.id,
        reason: teamCheck.reason,
        userTeamId,
        expectedTeamId,
      });
      // Item 9: Return ephemeral message with rejection reason (no secrets exposed)
      await sendEphemeralRejection(payload.response_url, teamCheck.reason);
      return;
    }
  }

  // P0 Item 5: When strict mode is ON, require allowedUserIds OR valid voter binding
  if (strictMode) {
    const { isSlackUserAuthorizedForApproval } = await import("@/lib/approval-workflow/slack-voter");
    const authCheck = await isSlackUserAuthorizedForApproval(
      channel.orgId,
      channel.id,
      userId,
      allowed,
      true
    );
    if (!authCheck.authorized) {
      console.warn("slack_approval_unauthorized", {
        channelId: channel.id,
        userId,
        reason: authCheck.reason,
      });
      // Item 9: Return ephemeral message with rejection reason (no secrets exposed)
      await sendEphemeralRejection(payload.response_url, authCheck.reason);
      return;
    }
  } else {
    // Existing behavior: only check allowedUserIds if non-empty
    if (allowed.length > 0 && (!userId || !allowed.includes(userId))) {
      // Item 9: Return ephemeral message for non-strict mode too
      await sendEphemeralRejection(payload.response_url, "not_in_allowed_list");
      return;
    }
  }

  const action = (payload.actions || []).find((item) =>
    ["staffpass_approve", "staffpass_reject", "staffpass_revise"].includes(item.action_id || "")
  );
  if (!action?.action_id || !action.value || !ts || !slackChannel) return;

  const approval = await getApprovalByTelegramRef(action.value, channel.orgId);
  if (!approval || approval.status !== "pending") return;
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
    /**
     * Item 10: W1 Replay Protection
     *
     * The decisionId (hash of rawBody) provides request uniqueness but is NOT the primary
     * replay defense. The actual replay protection is:
     *
     * 1. Pre-check: `approval.status !== "pending"` above rejects already-resolved tickets
     * 2. Atomic update: resolveApproval only updates if status = pending (conditional write)
     * 3. No double-fulfill: if resolveApproval returns null (already resolved), fulfill is skipped
     *
     * A replayed request with the same decisionId on an already-resolved ticket:
     * - Hits the status !== "pending" check and returns early (no-op)
     * - Even if it passes the check due to race, the conditional update fails
     * - No re-triggering of fulfillment side effects
     *
     * The decisionId is stored in approval.metadata for audit/debugging but does not
     * provide uniqueness enforcement at the database level.
     */
    const updated = await resolveApproval(approval.id, decision, actor, channel.orgId, { decisionId, externalVoter: { provider: "slack", channelKey: channel.id, userId } });
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
