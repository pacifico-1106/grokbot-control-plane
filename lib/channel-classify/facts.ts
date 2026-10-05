/**
 * PR-B fact gathering. Slack: conversations.info / conversations.members /
 * users.info with the org's OWN conversation bot token (never the shared
 * approval app, never a process-wide token — resolveOrgSlackBotToken). Only
 * flags and counts are kept: no message content, no token in any result.
 * LINE / Telegram: the join event itself (their bot APIs cannot list members),
 * so facts are "unverified".
 */
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { getEnabledConversationAdapter } from "@/lib/data/conversation-adapters";
import type { ChannelFacts, ConversationType } from "@/lib/channel-classify/core";

export type SlackApi = (method: string, params: Record<string, string>, token: string) => Promise<Record<string, unknown>>;

const SLACK_TIMEOUT_MS = 4_000;
const ALLOWED_METHODS = new Set(["conversations.info", "conversations.members", "users.info", "users.conversations"]);
/** Members whose profile is inspected (guest / external). More → membersComplete=false. */
export const MAX_MEMBERS_INSPECTED = 50;
const MAX_MEMBER_PAGES = 5;
const MAX_INTERNAL_IDS = 20;

const defaultSlackApi: SlackApi = async (method, params, token) => {
  if (!ALLOWED_METHODS.has(method)) throw new Error("slack_method_not_allowed");
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`https://slack.com/api/${method}?${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
};

async function defaultHomeTeamIds(orgId: string): Promise<string[]> {
  const ids = new Set<string>();
  const rule = await getOrgInternalAudienceRule(orgId).catch(() => null);
  for (const id of rule?.slackTeamIds ?? []) if (id) ids.add(String(id).trim().toUpperCase());
  const adapter = await getEnabledConversationAdapter(orgId, "slack").catch(() => null);
  const team = String(adapter?.config?.teamId || "").trim().toUpperCase();
  if (team) ids.add(team);
  return [...ids];
}

type Deps = {
  slackApi: SlackApi;
  resolveToken: (orgId: string) => Promise<string>;
  homeTeamIds: (orgId: string) => Promise<string[]>;
};
const DEFAULT_DEPS: Deps = { slackApi: defaultSlackApi, resolveToken: resolveOrgSlackBotToken, homeTeamIds: defaultHomeTeamIds };
let deps: Deps = DEFAULT_DEPS;

export function setChannelFactsDepsForTests(override: Partial<Deps> | null): void {
  deps = override ? { ...DEFAULT_DEPS, ...override } : DEFAULT_DEPS;
}

export function slackApi(): SlackApi {
  return deps.slackApi;
}

export async function resolveFactsToken(orgId: string): Promise<string> {
  return (await deps.resolveToken(orgId).catch(() => "")) || "";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

async function homeTeams(orgId: string, hint?: string | null): Promise<Set<string>> {
  const ids = new Set((await deps.homeTeamIds(orgId).catch(() => [])).map((id) => id.trim().toUpperCase()).filter(Boolean));
  const h = (hint || "").trim().toUpperCase();
  if (/^T[A-Z0-9]{2,30}$/.test(h)) ids.add(h);
  return ids;
}

type MemberVerdict = "internal" | "external" | "guest" | "bot" | "unknown";

function classifyUser(user: Record<string, unknown>, teams: Set<string>): MemberVerdict {
  if (user.is_bot === true || user.deleted === true) return "bot";
  if (user.is_restricted === true || user.is_ultra_restricted === true) return "guest";
  if (user.is_stranger === true) return "external";
  const team = String(user.team_id || user.team || "").trim().toUpperCase();
  if (!team || teams.size === 0) return "unknown";
  return teams.has(team) ? "internal" : "external";
}

/**
 * Slack facts for a channel, or null when the org has no conversation bot
 * token / Slack does not show the channel. Never throws.
 */
export async function collectSlackChannelFacts(
  orgId: string,
  channelId: string,
  opts: { homeTeamId?: string | null } = {}
): Promise<ChannelFacts | null> {
  try {
    const token = await resolveFactsToken(orgId);
    if (!token || !channelId) return null;
    const api = deps.slackApi;
    const info = await api("conversations.info", { channel: channelId, include_num_members: "true" }, token);
    const ch = rec(info.channel);
    if (info.ok !== true || !Object.keys(ch).length) return null;
    const isIm = ch.is_im === true;
    const isMpim = ch.is_mpim === true;
    const conversationType: ConversationType = isIm
      ? "im"
      : isMpim
        ? "mpim"
        : ch.is_private === true || ch.is_group === true
          ? "private_channel"
          : "public_channel";
    const base: ChannelFacts = {
      surface: "slack",
      externalId: channelId,
      conversationType,
      isPrivate: bool(ch.is_private) ?? (isIm || isMpim ? true : null),
      isShared: bool(ch.is_shared),
      isExtShared: ch.is_ext_shared === true || ch.is_ext_shared_plus === true ? true : bool(ch.is_ext_shared),
      isIm,
      isMpim,
      memberCount: typeof ch.num_members === "number" ? ch.num_members : null,
      internalMembers: null,
      externalMembers: null,
      guestMembers: null,
      membersComplete: false,
      internalMemberIds: [],
    };
    if (isIm) return base;

    const ids: string[] = [];
    let cursor = "";
    let listedAll = false;
    for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
      const res = await api("conversations.members", { channel: channelId, limit: "200", ...(cursor ? { cursor } : {}) }, token);
      if (res.ok !== true) break;
      for (const id of Array.isArray(res.members) ? res.members : []) if (typeof id === "string") ids.push(id);
      cursor = String(rec(res.response_metadata).next_cursor || "");
      if (!cursor) {
        listedAll = true;
        break;
      }
    }
    if (!ids.length) return base;
    const teams = await homeTeams(orgId, opts.homeTeamId);
    const inspected = ids.slice(0, MAX_MEMBERS_INSPECTED);
    const verdicts: MemberVerdict[] = [];
    for (let i = 0; i < inspected.length; i += 10) {
      const chunk = inspected.slice(i, i + 10);
      const results = await Promise.all(
        chunk.map(async (user) => {
          const res = await api("users.info", { user }, token).catch(() => ({ ok: false }) as Record<string, unknown>);
          return res.ok === true ? classifyUser(rec(res.user), teams) : ("unknown" as MemberVerdict);
        })
      );
      verdicts.push(...results);
    }
    const internalIds = inspected.filter((_, i) => verdicts[i] === "internal");
    return {
      ...base,
      memberCount: base.memberCount ?? ids.length,
      internalMembers: internalIds.length,
      externalMembers: verdicts.filter((v) => v === "external").length,
      guestMembers: verdicts.filter((v) => v === "guest").length,
      membersComplete: listedAll && ids.length <= MAX_MEMBERS_INSPECTED && !verdicts.includes("unknown"),
      internalMemberIds: internalIds.slice(0, MAX_INTERNAL_IDS),
    };
  } catch {
    return null;
  }
}

export type SlackUserFacts = { guest: boolean; external: boolean | null };

/** Guest / external status of one Slack user for the parties.upsert card. Never throws. */
export async function inspectSlackUserFacts(orgId: string, userId: string): Promise<SlackUserFacts | null> {
  try {
    const token = await resolveFactsToken(orgId);
    if (!token || !userId) return null;
    const res = await deps.slackApi("users.info", { user: userId }, token);
    if (res.ok !== true) return null;
    const verdict = classifyUser(rec(res.user), await homeTeams(orgId));
    return { guest: verdict === "guest", external: verdict === "unknown" || verdict === "bot" ? null : verdict === "external" };
  } catch {
    return null;
  }
}

/** Channels the org's Slack bot is a member of (backfill). Throws on failure (reported by the caller). */
export async function listSlackBotChannels(orgId: string, maxChannels: number): Promise<Array<{ id: string; isIm: boolean }>> {
  const token = await resolveFactsToken(orgId);
  if (!token) throw new Error("slack_conversation_bot_token_missing");
  const out: Array<{ id: string; isIm: boolean }> = [];
  let cursor = "";
  for (let page = 0; page < 20 && out.length < maxChannels; page += 1) {
    const res = await deps.slackApi(
      "users.conversations",
      { types: "public_channel,private_channel,mpim,im", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) },
      token
    );
    if (res.ok !== true) throw new Error(`slack_${String(res.error || "list_failed").replace(/[^a-z_]/g, "").slice(0, 40)}`);
    for (const raw of Array.isArray(res.channels) ? res.channels : []) {
      const ch = rec(raw);
      if (typeof ch.id === "string") out.push({ id: ch.id, isIm: ch.is_im === true });
      if (out.length >= maxChannels) break;
    }
    cursor = String(rec(res.response_metadata).next_cursor || "");
    if (!cursor) break;
  }
  return out;
}
// TDD stub (replaced in the implementation commit).
export const SLACK_MIN_INTERVAL_MS: Record<string, number> = {};
