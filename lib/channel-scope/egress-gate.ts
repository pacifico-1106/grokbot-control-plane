/**
 * P1 Channel Scope — CS4 send gate for auto-joined Slack Connect channels.
 *
 * Design §5: on a Connect channel that only automatic classification put in the ledger
 * (org_channels.source ≠ manual) and no human has confirmed (human_confirmed_at is null),
 * every send (slack.post / comm.send / comm.reply / slack.post_external, including file
 * attachments) needs human approval while the effective policy says
 * connect.egress = "needs_approval_until_confirmed" (the default). connect.egress = "matrix"
 * leaves it to the existing audience × information-class matrix.
 *
 * This only ever ADDS an approval. It never turns a deny into anything else and never skips
 * the existing matrix (the caller runs it after deny / voice checks).
 *
 * Flag OFF (P1_CHANNEL_SCOPE_ENABLED) ⇒ { required: false } with no DB access.
 * Lookup failure with the flag ON ⇒ required (fail-closed to approval, not deny).
 */
import { isChannelScopeEnabled } from "@/lib/feature-flags";
import { getChannelScopeChannel, getEffectiveChannelScope, SLACK_CONVERSATION_ID_RE } from "./data";
import type { ChannelScopeChannel } from "./types";

export type ConnectEgressGateReason =
  | "flag_off"
  | "not_a_channel"
  | "egress_matrix"
  | "not_in_ledger"
  | "not_connect"
  | "manual_row"
  | "human_confirmed"
  | "connect_unconfirmed"
  | "lookup_failed";

export interface ConnectEgressGate {
  required: boolean;
  reason: ConnectEgressGateReason;
  channelId?: string;
  externalTeamIds?: string[];
  source?: string;
}

export function isUnconfirmedAutoConnect(channel: ChannelScopeChannel | null | undefined): boolean {
  if (!channel) return false;
  const connect = channel.classification === "shared_external" || channel.mixed;
  return connect && (channel.source ?? "manual") !== "manual" && !channel.humanConfirmedAt;
}

export async function evaluateConnectEgressGate(input: {
  orgId: string;
  employeeId: string;
  slackChannelId: string | null | undefined;
}): Promise<ConnectEgressGate> {
  if (!isChannelScopeEnabled()) return { required: false, reason: "flag_off" };
  const channelId = (input.slackChannelId ?? "").trim().toUpperCase();
  if (!SLACK_CONVERSATION_ID_RE.test(channelId)) return { required: false, reason: "not_a_channel" };
  try {
    const scope = await getEffectiveChannelScope(input.orgId, input.employeeId);
    if (scope.policy.connect.egress === "matrix") return { required: false, reason: "egress_matrix", channelId };
    const channel = await getChannelScopeChannel(input.orgId, "slack", channelId);
    if (!channel) return { required: false, reason: "not_in_ledger", channelId };
    const meta = { channelId, externalTeamIds: channel.externalTeamIds ?? [], source: channel.source ?? "manual" };
    if (!(channel.classification === "shared_external" || channel.mixed)) return { required: false, reason: "not_connect", ...meta };
    if ((channel.source ?? "manual") === "manual") return { required: false, reason: "manual_row", ...meta };
    if (channel.humanConfirmedAt) return { required: false, reason: "human_confirmed", ...meta };
    return { required: true, reason: "connect_unconfirmed", ...meta };
  } catch {
    return { required: true, reason: "lookup_failed", channelId };
  }
}
