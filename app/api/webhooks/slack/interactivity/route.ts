/**
 * Single Slack interactivity endpoint.
 * P0 Item 3: Resolves target notification channel by (api_app_id, team_id, channel+message ts)
 * instead of per-ref URL.
 *
 * Security:
 * - Bounded candidate search: only channels matching api_app_id + team_id are tried
 * - Never iterates all orgs' secrets unbounded
 * - Rejects expired cards
 * - Ephemeral rejection message to presser
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import {
  getApprovalByTelegramRef,
  getApprovalById,
  getEmployee,
  resolveApproval,
} from "@/lib/data";
import {
  getApprovalIdByDeliveryExternal,
  getNotificationDelivery,
} from "@/lib/data/notification-channels";
import { extraApproversAllow } from "@/lib/employees/approval-inbox";
import { verifySlackSignature } from "@/lib/notify/slack";
import { isSelfApprovalDenied } from "@/lib/admin-mcp/self-approval";
import {
  alertApprovalDeliveryFailure,
  isApprovalDeliveryFailureAlertEnabled,
} from "@/lib/notify/delivery-failure-alert";
import { getMemberIdFromVoterBinding } from "@/lib/approval-workflow";
import { approverAuthorityReplyJa } from "@/lib/approver-authority/reply";
import {
  findChannelCandidatesByAppAndTeam,
  type InteractivityChannelCandidate,
} from "@/lib/slack/interactivity-channel-resolver";
import { isSharedApprovalAppRequest, isSharedApprovalAppRequestWhileDisabled } from "@/lib/slack/shared-approval-flags";
import {
  sendEphemeralRejection,
  type SlackRejectionReason,
} from "@/lib/slack/ephemeral-rejection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SlackUser = { id?: string; team_id?: string };
type SlackTeam = { id?: string };
type SlackChannel = { id?: string };
type SlackAction = { action_id?: string; value?: string; type?: string };
type SlackPayload = {
  type?: string;
  challenge?: string;
  api_app_id?: string;
  team?: SlackTeam;
  user?: SlackUser;
  channel?: SlackChannel;
  container?: { message_ts?: string; channel_id?: string };
  message?: { ts?: string };
  actions?: SlackAction[];
  response_url?: string;
};

type SignatureVerificationResult =
  | { ok: true; channel: InteractivityChannelCandidate }
  | { ok: false; reason: string };

const CARD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function ack(extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...extra });
}

async function verifySignatureWithCandidates(
  candidates: InteractivityChannelCandidate[],
  timestamp: string,
  rawBody: string,
  signature: string
): Promise<SignatureVerificationResult> {
  if (candidates.length === 0) {
    return { ok: false, reason: "no_candidates" };
  }

  const matchedCandidates: InteractivityChannelCandidate[] = [];
  for (const candidate of candidates) {
    const signingSecret = candidate.signingSecret?.trim() || "";
    if (!signingSecret) continue;

    if (
      verifySlackSignature({
        signingSecret,
        timestamp,
        rawBody,
        signature,
      })
    ) {
      matchedCandidates.push(candidate);
    }
  }

  if (matchedCandidates.length === 0) {
    return { ok: false, reason: "signature_invalid" };
  }

  if (matchedCandidates.length > 1) {
    console.error("slack_interactivity_ambiguous_secret", {
      matchedOrgIds: matchedCandidates.map((c) => c.orgId),
      matchedChannelIds: matchedCandidates.map((c) => c.id),
    });
    return { ok: false, reason: "ambiguous_secret" };
  }

  return { ok: true, channel: matchedCandidates[0] };
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") || "";
  const signature = req.headers.get("x-slack-signature") || "";
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

  const apiAppId = payload.api_app_id || "";
  const teamId = payload.team?.id || payload.user?.team_id || "";

  if (!apiAppId || !teamId) {
    return ack({ ignored: true, reason: "missing_app_or_team" });
  }

  if (isSharedApprovalAppRequestWhileDisabled(apiAppId)) {
    // Review M1: a press on a card sent before the flag was turned OFF. Verified
    // with the shared signing secret → #236 button alert for that org; always 401.
    const { reportSharedApprovalPressWhileDisabled } = await import("@/lib/slack/shared-approval-interactivity");
    await reportSharedApprovalPressWhileDisabled({ apiAppId, teamId, timestamp, rawBody, signature });
    return NextResponse.json({ ok: false, error: "shared_approval_app_disabled" }, { status: 401 });
  }

  let channel: InteractivityChannelCandidate;
  if (isSharedApprovalAppRequest(apiAppId)) {
    // SLACK_SHARED_APPROVAL_APP_ENABLED: shared signing secret FIRST, then team → org.
    // Lazy: no new module edges on the per-tenant path / while the flag is OFF.
    const { resolveSharedApprovalInteractivity } = await import("@/lib/slack/shared-approval-interactivity");
    const shared = await resolveSharedApprovalInteractivity({ apiAppId, teamId, timestamp, rawBody, signature });
    if (!shared.ok) {
      return NextResponse.json({ ok: false, error: shared.error }, { status: shared.status });
    }
    channel = shared.channel;
  } else {
    const candidates = await findChannelCandidatesByAppAndTeam(apiAppId, teamId);

    const verifyResult = await verifySignatureWithCandidates(
      candidates,
      timestamp,
      rawBody,
      signature
    );

    if (!verifyResult.ok) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    channel = verifyResult.channel;
  }

  if (payload.api_app_id !== channel.apiAppId) {
    await alertButtonFailure(channel, "app_mismatch");
    return NextResponse.json({ ok: false, error: "app_mismatch" }, { status: 403 });
  }

  const expectedTeamId = channel.expectedTeamId || channel.teamId;
  if (expectedTeamId && teamId !== expectedTeamId) {
    await alertButtonFailure(channel, "team_mismatch");
    return NextResponse.json({ ok: false, error: "team_mismatch" }, { status: 403 });
  }

  if (payload.type !== "block_actions") return ack();

  try {
    await handleBlockActions(channel, payload, rawBody, timestamp, signature);
  } catch (error) {
    console.error("slack_interactivity_handle_failed", error);
    await alertButtonFailure(channel, "handler_error");
  }
  return ack();
}

/**
 * PR-3 (APPROVAL_DELIVERY_FAILURE_ALERT): a signature-verified press that could
 * not be processed. The approval is NOT granted (unchanged); this only makes
 * the failure visible to tenant admins / operators. Never throws.
 */
async function alertButtonFailure(
  channel: InteractivityChannelCandidate,
  reason: string,
  approvalId?: string | null
): Promise<void> {
  if (!isApprovalDeliveryFailureAlertEnabled()) return;
  await alertApprovalDeliveryFailure({
    orgId: channel.orgId,
    kind: "button_failed",
    approvalId: approvalId ?? null,
    provider: "slack",
    channelId: channel.id,
    reason,
  }).catch(() => undefined);
}

async function handleBlockActions(
  channel: InteractivityChannelCandidate,
  payload: SlackPayload,
  rawBody: string,
  timestamp: string,
  signature: string
) {
  const userId = payload.user?.id || "";
  const userTeamId = payload.user?.team_id || payload.team?.id || "";
  const slackChannel = payload.channel?.id || payload.container?.channel_id || "";
  const ts = payload.message?.ts || payload.container?.message_ts || "";
  const responseUrl = payload.response_url || "";

  const allowed = Array.isArray(channel.allowedUserIds)
    ? channel.allowedUserIds.map(String)
    : [];

  if (allowed.length > 0 && (!userId || !allowed.includes(userId))) {
    if (responseUrl) {
      await sendEphemeralRejection(responseUrl, "not_in_allowed_list" as SlackRejectionReason);
    }
    await alertButtonFailure(channel, "not_in_allowed_list");
    return;
  }

  const expectedTeamId = channel.expectedTeamId || channel.teamId;
  if (expectedTeamId && userTeamId && userTeamId !== expectedTeamId) {
    if (responseUrl) {
      await sendEphemeralRejection(responseUrl, "external_team_user" as SlackRejectionReason);
    }
    await alertButtonFailure(channel, "external_team_user");
    return;
  }

  const action = (payload.actions || []).find((item) =>
    ["staffpass_approve", "staffpass_reject", "staffpass_revise", "staffpass_verify_voter_binding", "staffpass_reject_voter_binding"].includes(item.action_id || "")
  );
  if (!action?.action_id || !ts || !slackChannel) return;

  if (action.action_id === "staffpass_verify_voter_binding" || action.action_id === "staffpass_reject_voter_binding") {
    const { handleVerificationButtonClick, handleVerificationRejection } = await import("@/lib/approval-workflow/voter-binding-verification");
    
    if (action.action_id === "staffpass_verify_voter_binding") {
      const result = await handleVerificationButtonClick({
        callbackValue: action.value || "",
        presserSlackUserId: userId,
        presserTeamId: userTeamId,
      });
      
      if (!result.ok && responseUrl) {
        await sendEphemeralRejection(responseUrl, "voter_binding_failed" as SlackRejectionReason, result.messageJa);
      }
    } else {
      await handleVerificationRejection({
        callbackValue: action.value || "",
        presserSlackUserId: userId,
      });
    }
    return;
  }

  if (!action.value) return;

  const approval = await getApprovalByTelegramRef(action.value, channel.orgId);
  if (!approval) {
    const approvalId = await getApprovalIdByDeliveryExternal({
      channelId: channel.id,
      externalMessageId: ts,
    });
    if (approvalId) {
      const foundApproval = await getApprovalById(approvalId, channel.orgId);
      if (!foundApproval || foundApproval.status !== "pending") {
        if (responseUrl) {
          await sendEphemeralRejection(responseUrl, "card_expired" as SlackRejectionReason);
        }
        return;
      }
    }
    return;
  }

  if (approval.status !== "pending") {
    if (responseUrl) {
      await sendEphemeralRejection(responseUrl, "card_expired" as SlackRejectionReason);
    }
    return;
  }

  const delivery = await getNotificationDelivery({
    approvalId: approval.id,
    channelId: channel.id,
  });

  const deliveryTs = delivery?.externalMessageId || "";
  const deliveryChannel = String(delivery?.context.channel || "");
  if (
    !delivery ||
    deliveryTs !== ts ||
    (deliveryChannel && deliveryChannel !== slackChannel)
  ) {
    if (responseUrl) {
      await sendEphemeralRejection(responseUrl, "delivery_mismatch" as SlackRejectionReason);
    }
    await alertButtonFailure(channel, "delivery_mismatch", approval.id);
    return;
  }

  const createdAt = new Date(approval.createdAt).getTime();
  if (Date.now() - createdAt > CARD_EXPIRY_MS) {
    if (responseUrl) {
      await sendEphemeralRejection(responseUrl, "card_expired" as SlackRejectionReason);
    }
    await alertButtonFailure(channel, "card_expired", approval.id);
    return;
  }

  const employeeForGate = await getEmployee(approval.employeeId, channel.orgId);
  if (!extraApproversAllow(userId, employeeForGate?.approverUserIds)) {
    if (responseUrl) {
      await sendEphemeralRejection(responseUrl, "not_in_allowed_list" as SlackRejectionReason);
    }
    await alertButtonFailure(channel, "approver_not_allowed", approval.id);
    return;
  }

  const actor = `slack:${userId || "unknown"}`;
  const decisionId = `slack:${channel.id}:${createHash("sha256").update(rawBody).digest("hex")}`;
  
  const memberId = await getMemberIdFromVoterBinding(channel.orgId, {
    provider: "slack",
    channelKey: channel.id,
    userId,
  });
  
  try {
    if (action.action_id === "staffpass_revise") {
      const updated = await resolveApproval(
        approval.id,
        "revision_requested",
        actor,
        channel.orgId,
        { revisionNote: "Slackから修正依頼", memberId }
      );
      if (updated) {
        const employee = await getEmployee(updated.employeeId, channel.orgId);
        await runApprovalResolveSideEffects({
          approval: updated,
          decision: "revision_requested",
          actorEmail: actor,
          employee,
          surface: "slack",
        });
      }
      return;
    }

    const decision = action.action_id === "staffpass_approve" ? "approved" : "rejected";
    let resolveReason = "";
    const updated = await resolveApproval(approval.id, decision, actor, channel.orgId, {
      decisionId,
      externalVoter: { provider: "slack", channelKey: channel.id, userId },
      memberId,
      onResolveResult: (r) => { resolveReason = r.reason; },
    });
    // PR-D: same approver-authority feedback as LINE / Telegram / web.
    const authorityReply = updated ? null : approverAuthorityReplyJa(resolveReason);
    if (authorityReply && responseUrl) {
      await sendEphemeralRejection(responseUrl, "approver_authority" as SlackRejectionReason, authorityReply);
    }
    if (updated) {
      await fulfillIfApproved(updated, decision);
      const employee = await getEmployee(updated.employeeId, channel.orgId);
      await runApprovalResolveSideEffects({
        approval: updated,
        decision,
        actorEmail: actor,
        employee,
        surface: "slack",
      });
    }
  } catch (error) {
    if (isSelfApprovalDenied(error)) {
      if (responseUrl) {
        await sendEphemeralRejection(responseUrl, "self_approval_denied" as SlackRejectionReason);
      }
      return;
    }
    throw error;
  }
}
