/**
 * Human-only stop of an AI→AI Slack thread from the cap-notice button.
 * Release / resume is dashboard-only (same as employee hold).
 *
 * Gate:
 * - thread guard flag ON
 * - stop_ref belongs to THIS org (channel.orgId)
 * - presser Slack user is NOT a linked AI employee (any org)
 * - presser is bound to an active member of this org (voter binding)
 */
import { getMemberById } from "@/lib/data/members";
import { getMemberIdFromVoterBinding } from "@/lib/approval-workflow/data";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  findLinkedIdentitiesBySlackUserId,
  stopPeerWakeThread,
} from "@/lib/data/ai-peer-wake";
import { isAiPeerWakeThreadGuardEnabled } from "@/lib/feature-flags";
import { resolveAppOrigin } from "@/lib/app-url";
import { PEER_WAKE_STOP_SLACK_ACTION_ID } from "@/lib/notify/ai-peer-wake-notice";

export { PEER_WAKE_STOP_SLACK_ACTION_ID };

export type InboxPeerWakeStopResult = { ok: boolean; code: string; text: string };

export function peerWakeSettingsLink(): string {
  return `${resolveAppOrigin()}/app/settings#ai-peer-wake`;
}

export async function stopPeerWakeFromInbox(input: {
  orgId: string;
  channelId: string;
  userId: string;
  stopRef: string;
}): Promise<InboxPeerWakeStopResult> {
  const refuse = (code: string, text: string): InboxPeerWakeStopResult => ({ ok: false, code, text });
  if (!isAiPeerWakeThreadGuardEnabled()) {
    return refuse("flag_off", "AI同士の会話停止はまだ有効になっていません。");
  }
  const stopRef = (input.stopRef || "").trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(stopRef)) return refuse("not_found", "対象が見つかりません。");

  const linked = await findLinkedIdentitiesBySlackUserId(input.userId);
  if (linked.state === "unavailable") {
    return refuse("identity_unavailable", `判定できないため、ここからは停止できません。管理画面から停止してください: ${peerWakeSettingsLink()}`);
  }
  if (linked.rows.length > 0) {
    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: linked.rows[0]?.employeeId ?? null,
      credentialId: null,
      action: "slack.peer_wake.stop_denied",
      purpose: "slack.peer_wake",
      summary: "AI社員からの会話停止を拒否した",
      metadata: { reason: "actor_is_employee", stopRef, presserSlackUserId: input.userId },
    }).catch(() => undefined);
    return refuse("actor_is_employee", "AI社員はこの会話を止められません。");
  }

  const memberId = await getMemberIdFromVoterBinding(input.orgId, {
    provider: "slack",
    channelKey: input.channelId,
    userId: input.userId,
  });
  const member = memberId ? await getMemberById(memberId, input.orgId) : null;
  if (!member || member.orgId !== input.orgId || member.status !== "active") {
    return refuse(
      "member_binding_required",
      `メンバー連携がないため、ここからは停止できません。管理画面から停止してください: ${peerWakeSettingsLink()}`
    );
  }

  const result = await stopPeerWakeThread({
    orgId: input.orgId,
    stopRef,
    stoppedBy: `member:${member.id}`,
  });
  if (result.state === "unavailable") {
    return refuse("unavailable", `停止できませんでした。管理画面から試してください: ${peerWakeSettingsLink()}`);
  }
  if (result.state === "not_found") return refuse("not_found", "対象が見つかりません。");
  if (result.state === "denied") return refuse(result.reason, "この操作は許可されていません。");

  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: null,
    credentialId: null,
    action: "slack.peer_wake.stopped",
    purpose: "slack.peer_wake",
    summary: result.state === "already_stopped" ? "AI同士の会話はすでに停止中" : "人がAI同士の会話を停止した",
    metadata: {
      reason: result.state,
      stopRef,
      threadId: result.thread.id,
      channel: result.thread.slackChannelId,
      thread_ts: result.thread.threadTs,
      actorMemberId: member.id,
      via: "slack",
    },
  }).catch(() => undefined);

  const head = result.state === "already_stopped" ? "すでに停止中です。" : "この会話の AI 同士の起動を止めました。";
  return {
    ok: true,
    code: result.state,
    text: `${head}解除は管理画面からのみです: ${peerWakeSettingsLink()}`,
  };
}
