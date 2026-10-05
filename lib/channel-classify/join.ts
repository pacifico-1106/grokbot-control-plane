/**
 * PR-B: one join → proposal flow for every surface. Each surface only maps its
 * own event into a ChannelJoinSignal; facts and tickets are shared.
 *
 *   Slack     member_joined_channel (employee identity or the org's own bot),
 *             channel_joined / group_joined (user-token apps)
 *   LINE      join (group / room) on the org's LINE inbox webhook
 *   Telegram  my_chat_member (bot left/kicked → member/administrator) on the
 *             org's per-inbox webhook
 *
 * The org comes only from the verified webhook context (Slack: the bound
 * employee or the team's single conversation adapter; LINE / Telegram: the
 * inbox whose signature / secret verified). Ambiguous → nothing.
 */
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import { getEmployeesBySlackUserIds } from "@/lib/data/slack-identities";
import { findSlackConversationAdaptersByTeam } from "@/lib/data/conversation-adapters";
import { unverifiedFacts, type ChannelFacts, type ConversationType, type JoinSurface } from "@/lib/channel-classify/core";
import { collectSlackChannelFacts } from "@/lib/channel-classify/facts";
import { proposeChannelClassification, type ProposalOutcome, type ProposalTrigger } from "@/lib/channel-classify/proposals";
import { notifyChannelStuck } from "@/lib/channel-classify/stuck-notify";

export type ChannelJoinSignal = {
  orgId: string;
  surface: JoinSurface;
  externalId: string;
  trigger: ProposalTrigger;
  conversationType?: ConversationType;
  /** Slack workspace where the event arrived (counts as an internal team). */
  homeTeamId?: string;
};

type Deps = {
  findEmployeeOrgsBySlackUser: (userId: string, teamId: string) => Promise<Array<{ orgId: string; employeeId: string }>>;
  findOrgsBySlackTeam: (teamId: string) => Promise<string[]>;
};

const DEFAULT_DEPS: Deps = {
  findEmployeeOrgsBySlackUser: async (userId, teamId) =>
    (await getEmployeesBySlackUserIds([userId], teamId)).map((row) => ({ orgId: row.orgId, employeeId: row.employeeId })),
  findOrgsBySlackTeam: async (teamId) =>
    [...new Set((await findSlackConversationAdaptersByTeam(teamId)).filter((row) => row.enabled).map((row) => row.orgId))],
};
let deps: Deps = DEFAULT_DEPS;

export function setJoinDepsForTests(override: Partial<Deps> | null): void {
  deps = override ? { ...DEFAULT_DEPS, ...override } : DEFAULT_DEPS;
}

const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,30}$/;
const SLACK_TEAM_RE = /^T[A-Z0-9]{2,30}$/;
const LINE_ID_RE = /^[CR][0-9a-zA-Z]{1,64}$/;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export const SLACK_JOIN_EVENT_TYPES = new Set(["member_joined_channel", "channel_joined", "group_joined"]);

/** Slack Events envelope → signals (one per org that owns the joining identity). */
export async function slackJoinSignals(envelope: unknown): Promise<ChannelJoinSignal[]> {
  const env = rec(envelope);
  const event = rec(env.event);
  const type = String(event.type || "");
  if (!SLACK_JOIN_EVENT_TYPES.has(type)) return [];
  const teamId = String(env.team_id || event.team || "").trim();
  if (!SLACK_TEAM_RE.test(teamId)) return [];
  const authorizations = Array.isArray(env.authorizations) ? env.authorizations.map(rec) : [];
  let channelId = "";
  let userId = "";
  let conversationType: ConversationType | undefined;
  let trigger: ProposalTrigger = "slack_member_joined";
  if (type === "member_joined_channel") {
    channelId = String(event.channel || "");
    userId = String(event.user || "");
    conversationType = event.channel_type === "G" ? "private_channel" : event.channel_type === "C" ? "public_channel" : undefined;
  } else {
    channelId = String(rec(event.channel).id || event.channel || "");
    userId = String(authorizations.find((a) => a.is_bot !== true)?.user_id || "");
    trigger = "slack_channel_joined";
    conversationType = type === "group_joined" ? "private_channel" : "public_channel";
  }
  if (!SLACK_CHANNEL_RE.test(channelId) || !SLACK_USER_RE.test(userId)) return [];

  let orgIds: string[] = [];
  const isOwnBot = authorizations.some((a) => a.is_bot === true && String(a.user_id || "") === userId);
  if (isOwnBot) {
    const orgs = await deps.findOrgsBySlackTeam(teamId).catch(() => []);
    orgIds = orgs.length === 1 ? orgs : []; // ambiguous workspace binding → nothing
  } else {
    orgIds = [...new Set((await deps.findEmployeeOrgsBySlackUser(userId, teamId).catch(() => [])).map((row) => row.orgId))];
  }
  return orgIds.map((orgId) => ({ orgId, surface: "slack" as const, externalId: channelId, trigger, conversationType, homeTeamId: teamId }));
}

type LineEventLike = { type?: string; source?: { type?: string; groupId?: string; roomId?: string; userId?: string } };

/** LINE join (bot added to a group / room) → signal. Other events → null. */
export function lineJoinSignal(channel: { orgId: string }, event: LineEventLike): ChannelJoinSignal | null {
  if (event?.type !== "join") return null;
  const source = event.source || {};
  const isGroup = source.type === "group";
  const id = isGroup ? source.groupId : source.type === "room" ? source.roomId : undefined;
  if (!channel.orgId || !id || !LINE_ID_RE.test(id)) return null;
  return { orgId: channel.orgId, surface: "line", externalId: id, trigger: "line_join", conversationType: isGroup ? "group" : "room" };
}

type TelegramMember = { status?: string; user?: { id?: number; is_bot?: boolean } };
type TelegramUpdateLike = {
  my_chat_member?: { chat?: { id?: number; type?: string }; old_chat_member?: TelegramMember; new_chat_member?: TelegramMember };
};

const TG_IN = new Set(["member", "administrator", "creator", "restricted"]);

/** Telegram my_chat_member (the bot itself added to a group / supergroup / channel) → signal. */
export function telegramJoinSignal(channel: { orgId: string }, update: TelegramUpdateLike): ChannelJoinSignal | null {
  const m = update?.my_chat_member;
  if (!m || !channel.orgId) return null;
  const chatType = String(m.chat?.type || "");
  if (!["group", "supergroup", "channel"].includes(chatType)) return null;
  const now = String(m.new_chat_member?.status || "");
  const before = String(m.old_chat_member?.status || "left");
  if (!TG_IN.has(now) || TG_IN.has(before)) return null;
  const id = m.chat?.id;
  if (!Number.isSafeInteger(id)) return null;
  return {
    orgId: channel.orgId,
    surface: "telegram",
    externalId: String(id),
    trigger: "telegram_my_chat_member",
    conversationType: chatType === "supergroup" ? "supergroup" : chatType === "channel" ? "channel" : "group",
  };
}

/** Gather facts for a signal (Slack: API; LINE / Telegram: unverified from the event). */
export async function factsForSignal(signal: ChannelJoinSignal): Promise<ChannelFacts> {
  if (signal.surface === "slack") {
    const facts = await collectSlackChannelFacts(signal.orgId, signal.externalId, { homeTeamId: signal.homeTeamId });
    if (facts) return facts;
  }
  return unverifiedFacts({ surface: signal.surface, externalId: signal.externalId }, signal.conversationType ?? "unknown");
}

/** Shared entry point for every surface. Never throws. */
export async function handleChannelJoin(signal: ChannelJoinSignal): Promise<ProposalOutcome> {
  if (!isChannelClassifyProposalsEnabled()) return { state: "flag_off" };
  try {
    const facts = await factsForSignal(signal);
    const outcome = await proposeChannelClassification({ orgId: signal.orgId, facts, trigger: signal.trigger });
    if (outcome.state === "error") {
      await notifyChannelStuck({
        orgId: signal.orgId,
        kind: "proposal_failed",
        ref: { surface: signal.surface, externalId: signal.externalId },
        reason: outcome.reason || "proposal_failed",
      });
    }
    return outcome;
  } catch {
    return { state: "error", reason: "join_failed" };
  }
}
// TDD stubs (replaced in the implementation commit).
export async function handleTelegramMyChatMember(_channel: unknown, _update: unknown): Promise<ProposalOutcome> { return { state: "error" }; }
export async function resolveAdapterBotIdentity(_orgId: string): Promise<null> { return null; }
export function resetAdapterBotIdentityCacheForTests(): void {}
