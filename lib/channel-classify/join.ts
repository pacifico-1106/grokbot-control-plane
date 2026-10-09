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
 *
 * Follow-up hardening (before the flag goes ON):
 * - N7 Slack: the event must have been delivered for the org's OWN
 *   conversation bot — envelope api_app_id == the adapter bot's app
 *   (auth.test → bots.info with the org's own token), any bot authorization
 *   == the adapter bot user, team == the adapter team; the own-bot path also
 *   needs event.user == that bot. Identity unknown → nothing. The shared
 *   approval app (SLACK_SHARED_APPROVAL_APP_ID) never counts.
 * - H1 Telegram: my_chat_member.from (who added the bot) must be a known
 *   member of the org: listed in the inbox's allowedUserIds, or holding a
 *   verified, unexpired, unrevoked voter binding on that inbox. An empty
 *   allowedUserIds does NOT mean "everyone" here. Unknown → skipped (audited
 *   once per hour per org, ids only). handleChannelJoin refuses a Telegram
 *   signal that did not pass this check.
 */
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import { getEmployeesBySlackUserIds } from "@/lib/data/slack-identities";
import { findSlackConversationAdaptersByTeam } from "@/lib/data/conversation-adapters";
import { unverifiedFacts, type ChannelFacts, type ConversationType, type JoinSurface } from "@/lib/channel-classify/core";
import { callOrgSlack, collectSlackChannelFacts, resolveFactsToken } from "@/lib/channel-classify/facts";
import { lookupVoterBindingMember, type VoterBindingLookup } from "@/lib/approval-workflow/data";
import { getMemberById } from "@/lib/data/members";
import { appendAuditEvent } from "@/lib/data/audit";
import { takeChannelStuckNoticeSlot, type NoticeSlot } from "@/lib/data/channel-classify";
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
  /** Set only after the surface's actor check passed (required for Telegram). */
  actorVerified?: boolean;
};

export type AdapterBotIdentity = { appId: string; botUserId: string; teamId: string };

type Deps = {
  findEmployeeOrgsBySlackUser: (userId: string, teamId: string) => Promise<Array<{ orgId: string; employeeId: string }>>;
  findOrgsBySlackTeam: (teamId: string) => Promise<string[]>;
  adapterBotIdentity: (orgId: string) => Promise<AdapterBotIdentity | null>;
  /** Legacy test override (string → found, null → none). Production uses telegramVoterBinding. */
  telegramVoterMember?: (orgId: string, channelKey: string, userId: string) => Promise<string | null>;
  /** #299 (木村 review): found / none / error. error is refused even for allowlisted adders. */
  telegramVoterBinding: (orgId: string, channelKey: string, userId: string) => Promise<VoterBindingLookup>;
  /** Shared once-per-hour slot for join_ignored audit rows. */
  joinAuditSlot: (input: { orgId: string; key: string; windowSeconds: number }) => Promise<NoticeSlot>;
  /** #280 pre-flag (木村 #281 review): the binding's member is still active in THIS org. */
  memberActiveInOrg: (orgId: string, memberId: string) => Promise<boolean>;
};

const IDENTITY_TTL_MS = 10 * 60 * 1000;
const IDENTITY_NEGATIVE_TTL_MS = 60 * 1000;
const MAX_IDENTITY_CACHE = 1_000;
const identityCache = new Map<string, { value: AdapterBotIdentity | null; expiresAt: number }>();

export function resetAdapterBotIdentityCacheForTests(): void {
  identityCache.clear();
}

/**
 * The org's own conversation bot: auth.test (bot user, team, bot id) →
 * bots.info (app id), with the org's own token only. Cached per org
 * (10 min; failures 1 min). Any failure → null (callers fail closed).
 */
export async function resolveAdapterBotIdentity(orgId: string): Promise<AdapterBotIdentity | null> {
  if (!orgId) return null;
  const now = Date.now();
  const hit = identityCache.get(orgId);
  if (hit && hit.expiresAt > now) return hit.value;
  let value: AdapterBotIdentity | null = null;
  try {
    const token = await resolveFactsToken(orgId);
    if (token) {
      const auth = await callOrgSlack("auth.test", {}, token);
      const botId = String(auth.bot_id || "");
      const botUserId = String(auth.user_id || "");
      const teamId = String(auth.team_id || "");
      if (auth.ok === true && /^B[A-Z0-9]{2,30}$/.test(botId) && SLACK_USER_RE.test(botUserId) && SLACK_TEAM_RE.test(teamId)) {
        const info = await callOrgSlack("bots.info", { bot: botId }, token);
        const bot = rec(info.bot);
        const appId = String(bot.app_id || "");
        const sameUser = !bot.user_id || String(bot.user_id) === botUserId;
        if (info.ok === true && /^A[A-Z0-9]{2,30}$/.test(appId) && sameUser) value = { appId, botUserId, teamId };
      }
    }
  } catch {
    value = null;
  }
  if (identityCache.size >= MAX_IDENTITY_CACHE) identityCache.clear();
  identityCache.set(orgId, { value, expiresAt: now + (value ? IDENTITY_TTL_MS : IDENTITY_NEGATIVE_TTL_MS) });
  return value;
}

const DEFAULT_DEPS: Deps = {
  findEmployeeOrgsBySlackUser: async (userId, teamId) =>
    (await getEmployeesBySlackUserIds([userId], teamId)).map((row) => ({ orgId: row.orgId, employeeId: row.employeeId })),
  findOrgsBySlackTeam: async (teamId) =>
    [...new Set((await findSlackConversationAdaptersByTeam(teamId)).filter((row) => row.enabled).map((row) => row.orgId))],
  adapterBotIdentity: resolveAdapterBotIdentity,
  telegramVoterBinding: (orgId, channelKey, userId) =>
    lookupVoterBindingMember(orgId, { provider: "telegram", channelKey, userId }),
  joinAuditSlot: takeChannelStuckNoticeSlot,
  memberActiveInOrg: async (orgId, memberId) => {
    const member = await getMemberById(memberId, orgId);
    return Boolean(member && member.id === memberId && member.orgId === orgId && member.status === "active");
  },
};
let deps: Deps = DEFAULT_DEPS;

export function setJoinDepsForTests(override: Partial<Deps> | null): void {
  if (!override) {
    deps = DEFAULT_DEPS;
    return;
  }
  const legacy = override.telegramVoterMember;
  const adapted: Partial<Deps> =
    legacy && !override.telegramVoterBinding
      ? {
          telegramVoterBinding: async (orgId, channelKey, userId) => {
            const memberId = await legacy(orgId, channelKey, userId);
            return memberId ? { status: "found", memberId } : { status: "none" };
          },
        }
      : {};
  deps = { ...DEFAULT_DEPS, ...override, ...adapted };
}

const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,30}$/;
const SLACK_TEAM_RE = /^T[A-Z0-9]{2,30}$/;
const SLACK_APP_RE = /^A[A-Z0-9]{2,30}$/;
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

  // N7: which app the event was delivered for.
  const appId = String(env.api_app_id || "").trim();
  if (!SLACK_APP_RE.test(appId)) return [];
  const sharedApprovalAppId = (process.env.SLACK_SHARED_APPROVAL_APP_ID || "").trim();
  if (sharedApprovalAppId && appId === sharedApprovalAppId) return [];

  let orgIds: string[] = [];
  const isOwnBot = authorizations.some((a) => a.is_bot === true && String(a.user_id || "") === userId);
  if (isOwnBot) {
    const orgs = await deps.findOrgsBySlackTeam(teamId).catch(() => []);
    orgIds = orgs.length === 1 ? orgs : []; // ambiguous workspace binding → nothing
  } else {
    orgIds = [...new Set((await deps.findEmployeeOrgsBySlackUser(userId, teamId).catch(() => [])).map((row) => row.orgId))];
  }

  const botAuthUsers = authorizations.filter((a) => a.is_bot === true).map((a) => String(a.user_id || ""));
  const verified: string[] = [];
  for (const orgId of orgIds) {
    const identity = await deps.adapterBotIdentity(orgId).catch(() => null);
    if (!identity || identity.appId !== appId || identity.teamId !== teamId) continue;
    if (botAuthUsers.some((user) => user !== identity.botUserId)) continue;
    if (isOwnBot && userId !== identity.botUserId) continue;
    verified.push(orgId);
  }
  return verified.map((orgId) => ({
    orgId,
    surface: "slack" as const,
    externalId: channelId,
    trigger,
    conversationType,
    homeTeamId: teamId,
    actorVerified: true,
  }));
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
  my_chat_member?: {
    chat?: { id?: number; type?: string };
    from?: { id?: number; is_bot?: boolean };
    old_chat_member?: TelegramMember;
    new_chat_member?: TelegramMember;
  };
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

type TelegramInbox = { id: string; orgId: string; config?: Record<string, unknown> | null };

const JOIN_AUDIT_WINDOW_SECONDS = 3600;
const joinAuditFallback = new Map<string, number>();

export function resetJoinAuditFallbackForTests(): void {
  joinAuditFallback.clear();
}

/**
 * Shared slot first; when it is unavailable (store / RPC error, denied) fall back to a
 * per-instance 1-hour window per org × key — same as no_admin_approver in proposals.ts —
 * so the row is capped rather than dropped.
 */
async function takeJoinAuditSlot(orgId: string, key: string): Promise<boolean> {
  const slot = await deps.joinAuditSlot({ orgId, key, windowSeconds: JOIN_AUDIT_WINDOW_SECONDS }).catch(() => null);
  if (slot?.state === "ok") return slot.allowed;
  const k = `${orgId}|${key}`;
  const now = Date.now();
  const last = joinAuditFallback.get(k);
  if (last !== undefined && now - last < JOIN_AUDIT_WINDOW_SECONDS * 1000) return false;
  if (joinAuditFallback.size > 10_000) joinAuditFallback.clear();
  joinAuditFallback.set(k, now);
  return true;
}

async function auditIgnoredJoin(
  orgId: string,
  surface: string,
  externalId: string,
  reason: string,
  ids: { memberId?: string } = {}
): Promise<void> {
  // Once per hour per org × reason: an outsider adding the bot to many groups cannot flood the audit log.
  if (!(await takeJoinAuditSlot(orgId, `join_ignored|${surface}|${reason}`))) return;
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    action: "channel_classify.join_ignored",
    purpose: "admin.channel",
    summary: `参加イベントを無視しました（${reason}）: ${surface} ${externalId}`,
    metadata: { auditClass: "admin", surface, externalId, reason, ...(ids.memberId ? { memberId: ids.memberId } : {}) },
  }).catch(() => undefined);
}

/**
 * Telegram my_chat_member on a verified inbox webhook → proposal, only when
 * the person who added the bot (from) is a known member of the inbox's org.
 */
export async function handleTelegramMyChatMember(channel: TelegramInbox, update: TelegramUpdateLike): Promise<ProposalOutcome> {
  if (!isChannelClassifyProposalsEnabled()) return { state: "flag_off" };
  try {
    const signal = telegramJoinSignal({ orgId: channel.orgId }, update);
    if (!signal) return { state: "skipped", reason: "not_a_join" };
    const from = update.my_chat_member?.from;
    const fromId = from?.id;
    let known = false;
    if (Number.isSafeInteger(fromId) && from?.is_bot !== true) {
      const allowed = Array.isArray(channel.config?.allowedUserIds) ? (channel.config!.allowedUserIds as unknown[]).map(String) : [];
      known = allowed.includes(String(fromId));
      // #280 pre-flag (木村 #281 review): a binding counts only while its
      // member is still active in THIS org. A binding to a removed / disabled /
      // invited / other-org member refuses — even for an allowlisted adder
      // (the binding is the fresher signal).
      // #299 (木村 review): a binding lookup ERROR is its own state, not "no
      // binding" — refused even for an allowlisted adder (adder_member_unverified).
      const binding: VoterBindingLookup = channel.id
        ? await deps.telegramVoterBinding(channel.orgId, channel.id, String(fromId)).catch(() => ({ status: "error" as const }))
        : { status: "none" };
      if (binding.status === "error") {
        await auditIgnoredJoin(channel.orgId, "telegram", signal.externalId, "adder_member_unverified");
        return { state: "skipped", reason: "adder_member_unverified" };
      }
      if (binding.status === "found") {
        const memberId = binding.memberId;
        const active = await deps.memberActiveInOrg(channel.orgId, memberId).catch(() => false);
        if (!active) {
          await auditIgnoredJoin(channel.orgId, "telegram", signal.externalId, "adder_member_inactive", { memberId });
          return { state: "skipped", reason: "adder_member_inactive" };
        }
        known = true;
      }
    }
    if (!known) {
      await auditIgnoredJoin(channel.orgId, "telegram", signal.externalId, "unknown_adder");
      return { state: "skipped", reason: "unknown_adder" };
    }
    return await handleChannelJoin({ ...signal, actorVerified: true });
  } catch {
    return { state: "error", reason: "join_failed" };
  }
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
  if (signal.surface === "telegram" && signal.actorVerified !== true) return { state: "skipped", reason: "actor_unverified" };
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
