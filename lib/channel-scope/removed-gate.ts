/**
 * P1 Channel Scope — CS6 removed-channel send deny (design §11.5).
 *
 * When the AI employee was REMOVED from a Slack channel (membership state 'removed': the bot was
 * kicked — channel_left / group_left / reconcile bot listing — or someone else removed the user),
 * every audience-gated send to that channel is denied, including execution of an approval that was
 * granted before the removal. Checked for the via that will actually post:
 *   posting_as=user ⇒ via=user, otherwise ⇒ via=bot.
 *
 * - Flag OFF (P1_CHANNEL_SCOPE_ENABLED) ⇒ { denied: false } with no DB access (byte-identical).
 * - Flag ON, lookup failure ⇒ denied (fail-closed).
 * - 'left' (the employee left on its own) and 'no record' are NOT denied here; the existing egress
 *   matrix and Slack itself (not_in_channel) still apply. A rejoin (member / out_of_scope) lifts it.
 */
import { isChannelScopeEnabled } from "@/lib/feature-flags";
import { listEmployeeChannelMemberships, SLACK_CONVERSATION_ID_RE } from "./data";
import type { MembershipVia } from "./types";

export type RemovedChannelGateReason = "flag_off" | "not_a_channel" | "not_removed" | "removed" | "lookup_failed";

export interface RemovedChannelGate {
  denied: boolean;
  reason: RemovedChannelGateReason;
  channelId?: string;
  via?: MembershipVia;
  removedAt?: string | null;
}

export const REMOVED_CHANNEL_DENY_CODE = "channel_membership_removed";

export function sendViaForPostingAs(postingAs: string | null | undefined): MembershipVia {
  return postingAs === "user" ? "user" : "bot";
}

export async function evaluateRemovedChannelGate(input: {
  orgId: string;
  employeeId: string;
  slackChannelId: string | null | undefined;
  postingAs: string | null | undefined;
}): Promise<RemovedChannelGate> {
  if (!isChannelScopeEnabled()) return { denied: false, reason: "flag_off" };
  const channelId = (input.slackChannelId ?? "").trim().toUpperCase();
  if (!SLACK_CONVERSATION_ID_RE.test(channelId)) return { denied: false, reason: "not_a_channel" };
  const via = sendViaForPostingAs(input.postingAs);
  try {
    const rows = await listEmployeeChannelMemberships(input.orgId, {
      employeeId: input.employeeId,
      externalId: channelId,
      limit: 10,
    });
    const row = rows.find((m) => m.via === via && m.surface === "slack");
    if (row?.state === "removed") return { denied: true, reason: "removed", channelId, via, removedAt: row.leftAt };
    return { denied: false, reason: "not_removed", channelId, via };
  } catch {
    return { denied: true, reason: "lookup_failed", channelId, via };
  }
}

export function removedChannelMessageJa(gate: RemovedChannelGate, tool: string): string {
  return gate.reason === "lookup_failed"
    ? `${tool}: チャンネル参加状況を確認できないため送信を拒否しました（fail-closed）`
    : `${tool}: AI社員（${gate.via === "user" ? "本人名義" : "Bot"}）はこのチャンネルから外されているため送信できません`;
}
