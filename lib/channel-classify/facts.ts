/**
 * PR-B fact gathering. Slack: conversations.info / conversations.members /
 * users.info with the org's OWN conversation bot token (never the shared
 * approval app, never a process-wide token — resolveOrgSlackBotToken). Only
 * flags and counts are kept: no message content, no token in any result.
 * LINE / Telegram: the join event itself (their bot APIs cannot list members),
 * so facts are "unverified".
 *
 * Follow-up hardening:
 * - every call takes an optional AbortSignal (N1: the approval card's overall
 *   budget aborts the background calls; loops stop once aborted);
 * - an optional pacer (N4: backfill) spaces calls per method, makes users.info
 *   sequential and turns a Slack `ratelimited` answer into a stop
 *   (SlackRateLimitedError with Retry-After), never a retry storm;
 * - auth.test / bots.info resolve the org's own bot identity (N7).
 */
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { getEnabledConversationAdapter } from "@/lib/data/conversation-adapters";
import type { ChannelFacts, ConversationType } from "@/lib/channel-classify/core";

export type SlackApi = (
  method: string,
  params: Record<string, string>,
  token: string,
  signal?: AbortSignal
) => Promise<Record<string, unknown>>;

const SLACK_TIMEOUT_MS = 4_000;
const ALLOWED_METHODS = new Set([
  "conversations.info",
  "conversations.members",
  "users.info",
  "users.conversations",
  "auth.test",
  "bots.info",
]);

/**
 * N4: minimum spacing per method when paced (backfill). Slack tiers: Tier 3
 * (~50/min) conversations.info / users.conversations; Tier 4 (~100/min)
 * conversations.members / users.info / bots.info. Kept under those with margin.
 */
export const SLACK_MIN_INTERVAL_MS = {
  "conversations.info": 1_300,
  "users.conversations": 1_300,
  "conversations.members": 700,
  "users.info": 700,
  "bots.info": 700,
  "auth.test": 200,
} as const;

export class SlackRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("slack_ratelimited");
  }
}

export type SlackPacer = {
  call: (method: string, run: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>;
  readonly rateLimited: { retryAfterSeconds: number } | null;
};

/** Per-method spacing + stop on `ratelimited` (Retry-After kept for the caller). */
export function createSlackPacer(clock: { now: () => number; sleep: (ms: number) => Promise<void> }): SlackPacer {
  const last = new Map<string, number>();
  let limited: { retryAfterSeconds: number } | null = null;
  return {
    get rateLimited() {
      return limited;
    },
    async call(method, run) {
      if (limited) throw new SlackRateLimitedError(limited.retryAfterSeconds);
      const min = (SLACK_MIN_INTERVAL_MS as Record<string, number>)[method] ?? 1_300;
      const prev = last.get(method);
      if (prev !== undefined) {
        const wait = prev + min - clock.now();
        if (wait > 0) await clock.sleep(wait);
      }
      last.set(method, clock.now());
      const res = await run();
      if (res.ok !== true && res.error === "ratelimited") {
        const raw = Number(res.retry_after);
        limited = { retryAfterSeconds: Number.isFinite(raw) && raw > 0 ? Math.min(Math.ceil(raw), 3_600) : 60 };
        throw new SlackRateLimitedError(limited.retryAfterSeconds);
      }
      return res;
    },
  };
}

export type SlackCallOptions = { signal?: AbortSignal; pacer?: SlackPacer };
/** Members whose profile is inspected (guest / external). More → membersComplete=false. */
export const MAX_MEMBERS_INSPECTED = 50;
const MAX_MEMBER_PAGES = 5;
const MAX_INTERNAL_IDS = 20;

const defaultSlackApi: SlackApi = async (method, params, token, signal) => {
  if (!ALLOWED_METHODS.has(method)) throw new Error("slack_method_not_allowed");
  const query = new URLSearchParams(params).toString();
  const timeout = AbortSignal.timeout(SLACK_TIMEOUT_MS);
  const response = await fetch(`https://slack.com/api/${method}?${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (response.status === 429) {
    return { ok: false, error: "ratelimited", retry_after: Number(response.headers.get("retry-after") || "") || 60 };
  }
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
};

/** One Slack call honoring abort (never starts after abort) and the optional pacer. */
async function callSlack(method: string, params: Record<string, string>, token: string, opts: SlackCallOptions = {}) {
  if (opts.signal?.aborted) throw new Error("slack_call_aborted");
  const run = () => deps.slackApi(method, params, token, opts.signal);
  return opts.pacer ? opts.pacer.call(method, run) : run();
}

export async function callOrgSlack(method: string, params: Record<string, string>, token: string, opts: SlackCallOptions = {}) {
  return callSlack(method, params, token, opts);
}

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
  opts: { homeTeamId?: string | null; maxMembersInspected?: number } & SlackCallOptions = {}
): Promise<ChannelFacts | null> {
  try {
    const token = await resolveFactsToken(orgId);
    if (!token || !channelId) return null;
    const call = { signal: opts.signal, pacer: opts.pacer };
    const api = (method: string, params: Record<string, string>) => callSlack(method, params, token, call);
    const maxInspected = Math.max(1, Math.min(MAX_MEMBERS_INSPECTED, opts.maxMembersInspected ?? MAX_MEMBERS_INSPECTED));
    const info = await api("conversations.info", { channel: channelId, include_num_members: "true" });
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
      const res = await api("conversations.members", { channel: channelId, limit: "200", ...(cursor ? { cursor } : {}) });
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
    const inspected = ids.slice(0, maxInspected);
    const verdicts: MemberVerdict[] = [];
    // Paced (backfill): one users.info at a time. Otherwise small parallel chunks.
    const chunkSize = opts.pacer ? 1 : 10;
    for (let i = 0; i < inspected.length; i += chunkSize) {
      if (opts.signal?.aborted) return null;
      if (opts.pacer?.rateLimited) return null;
      const chunk = inspected.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(async (user) => {
          const res = await api("users.info", { user }).catch((error) => {
            if (error instanceof SlackRateLimitedError) throw error;
            return { ok: false } as Record<string, unknown>;
          });
          return res.ok === true ? classifyUser(rec(res.user), teams) : ("unknown" as MemberVerdict);
        })
      );
      verdicts.push(...results);
    }
    if (opts.signal?.aborted) return null;
    const internalIds = inspected.filter((_, i) => verdicts[i] === "internal");
    return {
      ...base,
      memberCount: base.memberCount ?? ids.length,
      internalMembers: internalIds.length,
      externalMembers: verdicts.filter((v) => v === "external").length,
      guestMembers: verdicts.filter((v) => v === "guest").length,
      membersComplete: listedAll && ids.length <= maxInspected && !verdicts.includes("unknown"),
      internalMemberIds: internalIds.slice(0, MAX_INTERNAL_IDS),
    };
  } catch {
    return null;
  }
}

export type SlackUserFacts = { guest: boolean; external: boolean | null };

/** Guest / external status of one Slack user for the parties.upsert card. Never throws. */
export async function inspectSlackUserFacts(orgId: string, userId: string, opts: SlackCallOptions = {}): Promise<SlackUserFacts | null> {
  try {
    const token = await resolveFactsToken(orgId);
    if (!token || !userId) return null;
    const res = await callSlack("users.info", { user: userId }, token, opts);
    if (opts.signal?.aborted) return null;
    if (res.ok !== true) return null;
    const verdict = classifyUser(rec(res.user), await homeTeams(orgId));
    return { guest: verdict === "guest", external: verdict === "unknown" || verdict === "bot" ? null : verdict === "external" };
  } catch {
    return null;
  }
}

/** Channels the org's Slack bot is a member of (backfill). Throws on failure (reported by the caller). */
export async function listSlackBotChannels(
  orgId: string,
  maxChannels: number,
  opts: SlackCallOptions = {}
): Promise<Array<{ id: string; isIm: boolean }>> {
  const token = await resolveFactsToken(orgId);
  if (!token) throw new Error("slack_conversation_bot_token_missing");
  const out: Array<{ id: string; isIm: boolean }> = [];
  let cursor = "";
  for (let page = 0; page < 20 && out.length < maxChannels; page += 1) {
    const res = await callSlack(
      "users.conversations",
      { types: "public_channel,private_channel,mpim,im", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) },
      token,
      opts
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
