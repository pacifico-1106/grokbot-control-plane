/**
 * P1 Channel Scope — CS5 reconcile (design §4.6, §10 照合, §11.4/5/7).
 *
 * users.conversations (types=public_channel,private_channel, cursor paging) is compared with
 * employee_channel_memberships and org_channels to:
 * - fill missed join events (backfill: channels the employee is in but we have no active row for),
 * - detect later sharing (listing says ext-shared ⇒ org_channels made stricter, Connect channels the
 *   policy excludes move out of scope),
 * - detect leaves / bot removal (an active row whose channel is no longer listed ⇒ left / removed).
 *
 * Two vias, mirroring CS3:
 * - user: the employee's linked user token (employee_slack_identities).
 * - bot:  the org's enabled Slack adapter bot token, only when the employee is a CS3 bot subject
 *         (linked identity in the adapter team, all linked identities of that team in ONE org).
 *         The listing is fetched once per org per run and shared.
 *
 * Safety rules:
 * - Flag OFF (P1_CHANNEL_SCOPE_ENABLED) ⇒ nothing runs, no DB / Slack access.
 * - Automatic ledger writes are stricter-only (upsertAutoClassifiedChannel, source='reconcile').
 *   Additionally reconcile never moves a human-made row (source=manual) or a human-confirmed row
 *   toward internal; only auto rows still 'unknown' may be refined to internal (same rule as CS3).
 * - Leaves are only derived from a COMPLETE listing (all pages fetched). A partial listing
 *   (rate limit / budget / API error) never marks anything left.
 * - Apply re-reads each membership first: a row changed by a real event after the listing
 *   started is skipped (events win over reconcile).
 * - Membership states follow the effective policy exactly like CS3 joins (registered_only ⇒
 *   out_of_scope, Connect excluded by policy ⇒ out_of_scope). Sends on auto Connect channels stay
 *   gated until a human confirms them (CS4) — reconcile never sets human_confirmed_at.
 * - Rate limit: calls per org are serial, spaced ≥ 3 s (≤ 20 req/min, tier 2) with a per-run
 *   budget; HTTP 429 ⇒ follow Retry-After when short (bounded retries), otherwise stop that listing
 *   as incomplete and let the next run continue.
 * - Metadata only; message bodies are never read.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getEnabledConversationAdapter } from "@/lib/data/conversation-adapters";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import {
  getEmployeeSlackIdentity,
  getLinkedSlackUserToken,
  listLinkedSlackIdentitiesForTeam,
} from "@/lib/data/slack-identities";
import { isChannelScopeEnabled } from "@/lib/feature-flags";
import { joinState } from "@/lib/slack/channel-membership-ingress";
import {
  getChannelScopeChannel,
  getEffectiveChannelScope,
  listAllEmployeeChannelMemberships,
  listChannelScopeChannels,
  listEmployeeChannelMemberships,
  MEMBERSHIP_LIST_MAX,
  SLACK_CONVERSATION_ID_RE,
  upsertAutoClassifiedChannel,
  upsertEmployeeChannelMembership,
} from "./data";
import { classifySlackConversation, mergeAutoClassification } from "./resolve";
import type {
  AutoClassification,
  ChannelScopeChannel,
  EffectiveChannelScope,
  EmployeeChannelMembership,
  MembershipState,
  MembershipVia,
  SlackConversationInfoLike,
} from "./types";
import type { ChannelClassification } from "@/lib/types";
import { SLACK_TEAM_ID_RE } from "./validate";

// ---------------------------------------------------------------------------
// Slack users.conversations + rate limiting
// ---------------------------------------------------------------------------

export type ListedConversation = SlackConversationInfoLike & { id: string };

export type UsersConversationsPage =
  | { ok: true; channels: ListedConversation[]; nextCursor: string | null }
  | { ok: false; rateLimited: true; retryAfterSec: number }
  | { ok: false; rateLimited?: false; error: string };

export type FetchUsersConversationsPage = (token: string, cursor: string | null) => Promise<UsersConversationsPage>;

const SLACK_TIMEOUT_MS = 8_000;
export const RECONCILE_PAGE_LIMIT = 200;
/** Tier 2 = 20 req/min per method per workspace; stay under it with serial calls ≥ 3 s apart. */
export const RECONCILE_MIN_INTERVAL_MS = 3_000;
/** Per org, per run. 18 pages × 200 = 3 600 channels; the rest continues next run (no leaves). */
export const RECONCILE_MAX_REQUESTS_PER_ORG = 18;
export const RECONCILE_MAX_BACKOFF_MS = 10_000;
export const RECONCILE_MAX_RETRIES = 2;
const MAX_PAGES = 100;

function toListed(raw: unknown): ListedConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const id = typeof c.id === "string" ? c.id.trim().toUpperCase() : "";
  if (!SLACK_CONVERSATION_ID_RE.test(id)) return null;
  if (c.is_im === true || c.is_mpim === true) return null;
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  return {
    id,
    is_ext_shared: bool(c.is_ext_shared),
    is_pending_ext_shared: bool(c.is_pending_ext_shared),
    is_shared: bool(c.is_shared),
    is_org_shared: bool(c.is_org_shared),
    context_team_id: typeof c.context_team_id === "string" ? c.context_team_id : null,
    connected_team_ids: list(c.connected_team_ids),
    pending_connected_team_ids: list(c.pending_connected_team_ids),
  };
}

/** Default users.conversations page fetcher. Never throws; never logs the token. */
export const fetchSlackUsersConversationsPage: FetchUsersConversationsPage = async (token, cursor) => {
  if (!token) return { ok: false, error: "token_missing" };
  try {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: String(RECONCILE_PAGE_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`https://slack.com/api/users.conversations?${params.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (response.status === 429) {
      const retry = Number.parseInt(response.headers.get("retry-after") || "", 10);
      return { ok: false, rateLimited: true, retryAfterSec: Number.isFinite(retry) && retry >= 0 ? retry : 30 };
    }
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      channels?: unknown[];
      response_metadata?: { next_cursor?: string };
    };
    if (!body.ok) {
      if (body.error === "ratelimited") return { ok: false, rateLimited: true, retryAfterSec: 30 };
      return { ok: false, error: typeof body.error === "string" ? body.error.slice(0, 64) : "slack_error" };
    }
    const channels = (Array.isArray(body.channels) ? body.channels : [])
      .map(toListed)
      .filter((c): c is ListedConversation => Boolean(c));
    const next = body.response_metadata?.next_cursor?.trim() || null;
    return { ok: true, channels, nextCursor: next };
  } catch {
    return { ok: false, error: "slack_unreachable" };
  }
};

export interface SlackRateLimiter {
  /** Waits for the next slot. false = this run's budget is used up. */
  acquire(): Promise<boolean>;
  readonly used: number;
  readonly budget: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Serial, spaced, budgeted limiter (one per org per run — tier limits are per workspace). */
export function createSlackRateLimiter(
  opts: {
    maxRequests?: number;
    minIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Epoch ms; no slot is handed out after it (the listing ends incomplete instead). */
    deadline?: number;
  } = {}
): SlackRateLimiter {
  const budget = Math.max(0, Math.floor(opts.maxRequests ?? RECONCILE_MAX_REQUESTS_PER_ORG));
  const interval = Math.max(0, opts.minIntervalMs ?? RECONCILE_MIN_INTERVAL_MS);
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  let used = 0;
  let last = -Infinity;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    get used() {
      return used;
    },
    budget,
    acquire() {
      const next = chain.then(async () => {
        if (used >= budget) return false;
        const wait = last + interval - now();
        if (opts.deadline !== undefined && now() + Math.max(0, wait) > opts.deadline) return false;
        if (wait > 0) await sleep(wait);
        used += 1;
        last = now();
        return true;
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

export interface ConversationListing {
  /** All pages fetched. Only a complete listing may produce leaves. */
  complete: boolean;
  channels: ListedConversation[];
  requests: number;
  retries: number;
  rateLimited: boolean;
  budgetExhausted: boolean;
  error: string | null;
  startedAt: string;
}

export async function listSlackConversationsForToken(
  token: string,
  opts: {
    limiter: SlackRateLimiter;
    fetchPage?: FetchUsersConversationsPage;
    sleep?: (ms: number) => Promise<void>;
    maxBackoffMs?: number;
    maxRetries?: number;
    nowIso?: () => string;
  }
): Promise<ConversationListing> {
  const fetchPage = opts.fetchPage ?? fetchSlackUsersConversationsPage;
  const sleep = opts.sleep ?? realSleep;
  const maxBackoff = opts.maxBackoffMs ?? RECONCILE_MAX_BACKOFF_MS;
  const maxRetries = opts.maxRetries ?? RECONCILE_MAX_RETRIES;
  const out: ConversationListing = {
    complete: false,
    channels: [],
    requests: 0,
    retries: 0,
    rateLimited: false,
    budgetExhausted: false,
    error: null,
    startedAt: (opts.nowIso ?? (() => new Date().toISOString()))(),
  };
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; ) {
    if (!(await opts.limiter.acquire())) {
      out.budgetExhausted = true;
      return out;
    }
    out.requests += 1;
    const page = await fetchPage(token, cursor);
    if (!page.ok) {
      if (page.rateLimited) {
        const waitMs = page.retryAfterSec * 1000;
        if (out.retries < maxRetries && waitMs <= maxBackoff) {
          out.retries += 1;
          await sleep(waitMs);
          continue; // same cursor
        }
        out.rateLimited = true;
        return out;
      }
      out.error = page.error;
      return out;
    }
    pages += 1;
    for (const c of page.channels) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.channels.push(c);
    }
    if (!page.nextCursor) {
      out.complete = true;
      return out;
    }
    cursor = page.nextCursor;
  }
  out.error = "too_many_pages";
  return out;
}

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

export type ReconcileAction = "add" | "classify" | "stricter" | "in_scope" | "out_of_scope" | "leave";

export interface ReconcileLedgerChange {
  from: { classification: ChannelClassification; mixed: boolean } | null;
  to: { classification: ChannelClassification; mixed: boolean; externalTeamIds: string[] };
  auto: Pick<AutoClassification, "classification" | "mixed" | "externalTeamIds" | "slackTeamId" | "basis">;
}

export interface ReconcileItem {
  /** `${via}:${channelId}:${action}` — what an approval covers. */
  key: string;
  action: ReconcileAction;
  via: MembershipVia;
  channelId: string;
  /** Target membership state (absent for a ledger-only "stricter"). */
  state?: MembershipState;
  /** Previous membership state (null = no row). */
  previousState: MembershipState | null;
  ledger?: ReconcileLedgerChange;
  /** true when the item puts something INTO scope (membership → member, or unknown → internal). */
  widens: boolean;
}

const ACTIVE: ReadonlySet<MembershipState> = new Set(["member", "out_of_scope"]);

function itemKey(via: MembershipVia, channelId: string, action: ReconcileAction): string {
  return `${via}:${channelId}:${action}`;
}

function isConnect(c: { classification: ChannelClassification; mixed: boolean }): boolean {
  return c.classification === "shared_external" || c.mixed;
}

/**
 * Reconcile may only make a ledger row stricter. The one refinement allowed is an AUTOMATIC row
 * (source ≠ manual) still 'unknown' and not human-confirmed becoming internal — same rule as a
 * CS3 join. Human rows are never moved toward internal by reconcile.
 */
export function reconcileLedgerChangeAllowed(
  existing: ChannelScopeChannel | null,
  merged: { classification: ChannelClassification; mixed: boolean; changed: boolean }
): boolean {
  if (!merged.changed) return false;
  if (!existing) return true;
  if (existing.classification !== "internal" && merged.classification === "internal") {
    return (existing.source ?? "manual") !== "manual" && !existing.humanConfirmedAt && existing.classification === "unknown";
  }
  return true;
}

export function planChannelScopeReconcile(input: {
  via: MembershipVia;
  scope: EffectiveChannelScope;
  listing: Pick<ConversationListing, "complete" | "channels">;
  memberships: EmployeeChannelMembership[];
  ledger: Map<string, ChannelScopeChannel>;
  internalSlackTeamIds: string[];
}): ReconcileItem[] {
  const items: ReconcileItem[] = [];
  const byChannel = new Map<string, EmployeeChannelMembership>();
  for (const m of input.memberships) if (m.via === input.via && m.surface === "slack") byChannel.set(m.externalId, m);
  const listedIds = new Set<string>();
  const registeredOnly = input.scope.policy.mode === "registered_only";

  for (const listed of input.listing.channels) {
    const channelId = listed.id;
    if (listedIds.has(channelId)) continue;
    listedIds.add(channelId);
    const mem = byChannel.get(channelId) ?? null;
    const active = Boolean(mem && ACTIVE.has(mem.state));
    const existing = input.ledger.get(channelId) ?? null;
    const auto = classifySlackConversation(listed, input.internalSlackTeamIds);
    const merged = mergeAutoClassification(existing, auto);
    // registered_only records memberships only (like a CS3 join) — no new ledger rows.
    const ledgerAllowed = reconcileLedgerChangeAllowed(existing, merged) && !(registeredOnly && !existing);
    const ledger: ReconcileLedgerChange | undefined = ledgerAllowed
      ? {
          from: existing ? { classification: existing.classification, mixed: existing.mixed } : null,
          to: { classification: merged.classification, mixed: merged.mixed, externalTeamIds: merged.externalTeamIds },
          auto: {
            classification: auto.classification,
            mixed: auto.mixed,
            externalTeamIds: auto.externalTeamIds,
            slackTeamId: auto.slackTeamId,
            basis: auto.basis,
          },
        }
      : undefined;
    const projected: ChannelScopeChannel | null = ledger
      ? {
          ...(existing ?? { externalId: channelId, source: "reconcile", humanConfirmedAt: null }),
          externalId: channelId,
          classification: ledger.to.classification,
          mixed: ledger.to.mixed,
          externalTeamIds: ledger.to.externalTeamIds,
          // Same as upsertAutoClassifiedChannel: first time Connect ⇒ earlier confirmation is void.
          humanConfirmedAt:
            existing?.humanConfirmedAt && !isConnect(existing) && isConnect(ledger.to) ? null : existing?.humanConfirmedAt ?? null,
        }
      : existing;
    const state: MembershipState =
      registeredOnly || !projected ? "out_of_scope" : joinState(input.scope, projected, input.via);
    const ledgerWidens = Boolean(ledger && ledger.from && ledger.from.classification !== "internal" && ledger.to.classification === "internal");
    const push = (action: ReconcileAction, target: MembershipState | undefined, widens: boolean) =>
      items.push({
        key: itemKey(input.via, channelId, action),
        action,
        via: input.via,
        channelId,
        ...(target ? { state: target } : {}),
        previousState: mem?.state ?? null,
        ...(ledger ? { ledger } : {}),
        widens: widens || ledgerWidens,
      });

    if (!active) {
      push("add", state, state === "member");
      continue;
    }
    if (registeredOnly) {
      // Memberships are not used for scope under registered_only; only keep the ledger strict.
      if (ledger) push("stricter", undefined, false);
      continue;
    }
    if (mem!.state !== state) {
      push(state === "member" ? "in_scope" : "out_of_scope", state, state === "member");
      continue;
    }
    if (ledger) push(existing ? "stricter" : "classify", undefined, false);
  }

  if (input.listing.complete) {
    for (const [channelId, mem] of byChannel) {
      if (listedIds.has(channelId) || !ACTIVE.has(mem.state)) continue;
      items.push({
        key: itemKey(input.via, channelId, "leave"),
        action: "leave",
        via: input.via,
        channelId,
        state: input.via === "bot" ? "removed" : "left",
        previousState: mem.state,
        widens: false,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ReconcileApplyResult {
  applied: number;
  failed: number;
  skipped: Array<{ key: string; reason: string }>;
}

function narrower(a: MembershipState, b: MembershipState): MembershipState {
  // member is the only in-scope state; anything else wins.
  return a === "member" ? b : a;
}

export async function applyReconcileItems(input: {
  orgId: string;
  employeeId: string;
  scope: EffectiveChannelScope;
  items: ReconcileItem[];
  listingStartedAt: string;
  runId: string;
  /** Admin approval: only these keys, and never wider than the approved state. */
  allowedKeys?: Set<string>;
}): Promise<ReconcileApplyResult> {
  const result: ReconcileApplyResult = { applied: 0, failed: 0, skipped: [] };
  const eventId = `reconcile:${input.runId}`.slice(0, 128);
  const registeredOnly = input.scope.policy.mode === "registered_only";
  for (const item of input.items) {
    const skip = (reason: string) => result.skipped.push({ key: item.key, reason });
    if (input.allowedKeys && !input.allowedKeys.has(item.key)) {
      skip("not_in_approved_plan");
      continue;
    }
    try {
      const row = (
        await listEmployeeChannelMemberships(input.orgId, { employeeId: input.employeeId, externalId: item.channelId, limit: 10 })
      ).find((m) => m.via === item.via && m.surface === "slack");
      const active = Boolean(row && ACTIVE.has(row.state));
      if (row && row.updatedAt > input.listingStartedAt) {
        skip("changed_since_listing");
        continue;
      }
      if (item.action === "leave") {
        if (!active) {
          skip("already_inactive");
          continue;
        }
        await upsertEmployeeChannelMembership({
          orgId: input.orgId,
          employeeId: input.employeeId,
          externalId: item.channelId,
          via: item.via,
          state: item.state!,
          eventId,
        });
        result.applied += 1;
        continue;
      }
      if (item.action === "add" ? active : !active) {
        skip(item.action === "add" ? "already_member" : "membership_changed");
        continue;
      }

      let channel: ChannelScopeChannel | null = await getChannelScopeChannel(input.orgId, "slack", item.channelId);
      if (item.ledger) {
        const merged = mergeAutoClassification(channel, item.ledger.auto);
        if (reconcileLedgerChangeAllowed(channel, merged) && !(registeredOnly && !channel)) {
          const written = await upsertAutoClassifiedChannel({
            orgId: input.orgId,
            externalId: item.channelId,
            auto: item.ledger.auto,
            source: "reconcile",
          });
          channel = written.channel;
        }
      }
      if (!item.state) {
        // Ledger-only item: a stricter classification may still push an active membership out of
        // scope (narrowing only — never the other way here).
        if (!registeredOnly && channel && row && row.state === "member" && joinState(input.scope, channel, item.via) === "out_of_scope") {
          await upsertEmployeeChannelMembership({
            orgId: input.orgId,
            employeeId: input.employeeId,
            externalId: item.channelId,
            via: item.via,
            state: "out_of_scope",
            eventId,
          });
        }
        result.applied += 1;
        continue;
      }
      let state: MembershipState = registeredOnly || !channel ? "out_of_scope" : joinState(input.scope, channel, item.via);
      if (input.allowedKeys) state = narrower(item.state, state);
      if (row && row.state === state) {
        result.applied += 1; // ledger-only effect
        continue;
      }
      await upsertEmployeeChannelMembership({
        orgId: input.orgId,
        employeeId: input.employeeId,
        externalId: item.channelId,
        via: item.via,
        state,
        eventId,
      });
      result.applied += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per employee
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  fetchPage?: FetchUsersConversationsPage;
  sleep?: (ms: number) => Promise<void>;
  /** One per org per run (shared by the user and bot listings of that workspace). */
  limiter?: SlackRateLimiter;
  /** Bot listing per org, shared by every employee in the run. */
  botListingCache?: Map<string, Promise<ConversationListing | null>>;
}

export interface ViaReconcileResult {
  via: MembershipVia;
  status: "reconciled" | "skipped";
  reason?: string;
  listing?: Omit<ConversationListing, "channels"> & { channels: number };
  membershipsTruncated?: boolean;
  items: ReconcileItem[];
  applied?: ReconcileApplyResult;
}

export interface EmployeeReconcileResult {
  ok: boolean;
  code?: string;
  orgId: string;
  employeeId: string;
  dryRun: boolean;
  mode: EffectiveChannelScope["policy"]["mode"];
  includeSlackConnect: boolean;
  scopeSource: EffectiveChannelScope["source"];
  vias: ViaReconcileResult[];
}

function teamOrNull(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim().toUpperCase() : "";
  return SLACK_TEAM_ID_RE.test(t) ? t : null;
}

/** Bot token for via=bot, only when the employee is a CS3 bot subject of this org. */
async function botTokenForEmployee(orgId: string, employeeId: string): Promise<{ token: string } | { reason: string }> {
  const adapter = await getEnabledConversationAdapter(orgId, "slack");
  const token = adapter?.secrets?.botToken?.trim() || "";
  if (!adapter || !token) return { reason: "bot_adapter_not_found" };
  const identity = await getEmployeeSlackIdentity(employeeId);
  if (!identity || identity.status !== "linked" || identity.orgId !== orgId) return { reason: "employee_not_bound" };
  const team = teamOrNull(identity.slackTeamId);
  const adapterTeam = teamOrNull(adapter.config?.teamId);
  if (!team || (adapterTeam && adapterTeam !== team)) return { reason: "bot_adapter_team_mismatch" };
  const linked = await listLinkedSlackIdentitiesForTeam(team);
  const orgs = new Set(linked.map((r) => r.orgId));
  if (orgs.size !== 1 || !orgs.has(orgId)) return { reason: "bot_org_ambiguous" };
  if (!linked.some((r) => r.employeeId === employeeId)) return { reason: "employee_not_bound" };
  return { token };
}

async function userTokenForEmployee(orgId: string, employeeId: string): Promise<{ token: string } | { reason: string }> {
  const identity = await getEmployeeSlackIdentity(employeeId);
  if (!identity || identity.status !== "linked" || identity.orgId !== orgId) return { reason: "employee_not_bound" };
  const token = await getLinkedSlackUserToken(employeeId);
  return token ? { token } : { reason: "no_user_token" };
}

async function ledgerFor(orgId: string, ids: string[]): Promise<Map<string, ChannelScopeChannel>> {
  const map = new Map<string, ChannelScopeChannel>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += MEMBERSHIP_LIST_MAX) {
    const rows = await listChannelScopeChannels(orgId, "slack", unique.slice(i, i + MEMBERSHIP_LIST_MAX));
    for (const r of rows) map.set(r.externalId, r);
  }
  return map;
}

const AUDIT_ITEM_CAP = 50;

export async function reconcileEmployeeChannelScope(
  input: {
    orgId: string;
    employeeId: string;
    dryRun: boolean;
    trigger: "cron" | "admin_mcp";
    runId: string;
    allowedKeys?: Set<string>;
    vias?: MembershipVia[];
  },
  deps: ReconcileDeps = {}
): Promise<EmployeeReconcileResult> {
  const scope = await getEffectiveChannelScope(input.orgId, input.employeeId);
  const base: EmployeeReconcileResult = {
    ok: true,
    orgId: input.orgId,
    employeeId: input.employeeId,
    dryRun: input.dryRun,
    mode: scope.policy.mode,
    includeSlackConnect: scope.policy.includeSlackConnect,
    scopeSource: scope.source,
    vias: [],
  };
  if (!isChannelScopeEnabled()) return { ...base, ok: false, code: "feature_disabled" };
  const limiter = deps.limiter ?? createSlackRateLimiter({ sleep: deps.sleep });
  const rule = await getOrgInternalAudienceRule(input.orgId);
  const { rows: allMemberships, truncated } = await listAllEmployeeChannelMemberships(input.orgId, input.employeeId);

  for (const via of input.vias ?? (["user", "bot"] as MembershipVia[])) {
    const tokenResult =
      via === "user" ? await userTokenForEmployee(input.orgId, input.employeeId) : await botTokenForEmployee(input.orgId, input.employeeId);
    if ("reason" in tokenResult) {
      base.vias.push({ via, status: "skipped", reason: tokenResult.reason, items: [] });
      continue;
    }
    const fetchListing = () =>
      listSlackConversationsForToken(tokenResult.token, { limiter, fetchPage: deps.fetchPage, sleep: deps.sleep });
    let listing: ConversationListing | null;
    if (via === "bot" && deps.botListingCache) {
      let cached = deps.botListingCache.get(input.orgId);
      if (!cached) {
        cached = fetchListing().catch(() => null);
        deps.botListingCache.set(input.orgId, cached);
      }
      listing = await cached;
    } else {
      listing = await fetchListing();
    }
    if (!listing) {
      base.vias.push({ via, status: "skipped", reason: "listing_failed", items: [] });
      continue;
    }
    const memberships = allMemberships.filter((m) => m.via === via);
    const ledger = await ledgerFor(input.orgId, [...listing.channels.map((c) => c.id), ...memberships.map((m) => m.externalId)]);
    // A truncated membership read could make known channels look new; never derive leaves from it.
    const items = planChannelScopeReconcile({
      via,
      scope,
      listing: { channels: listing.channels, complete: listing.complete && !truncated },
      memberships,
      ledger,
      internalSlackTeamIds: rule.slackTeamIds,
    });
    const { channels, ...listingMeta } = listing;
    const viaResult: ViaReconcileResult = {
      via,
      status: "reconciled",
      listing: { ...listingMeta, channels: channels.length },
      membershipsTruncated: truncated,
      items,
    };
    if (!input.dryRun) {
      viaResult.applied = await applyReconcileItems({
        orgId: input.orgId,
        employeeId: input.employeeId,
        scope,
        items,
        listingStartedAt: listing.startedAt,
        runId: input.runId,
        allowedKeys: input.allowedKeys,
      });
      await appendAuditEvent({
        orgId: input.orgId,
        employeeId: input.employeeId,
        credentialId: null,
        action: "channel_scope.reconcile_run",
        purpose: "channel_scope.reconcile",
        summary: `チャンネル範囲の照合（${via === "user" ? "ユーザー" : "Bot"}）: ${items.length}件の差分、${viaResult.applied.applied}件適用`,
        metadata: {
          runId: input.runId,
          trigger: input.trigger,
          via,
          mode: scope.policy.mode,
          includeSlackConnect: scope.policy.includeSlackConnect,
          listing: viaResult.listing,
          membershipsTruncated: truncated,
          counts: countByAction(items),
          widening: items.filter((i) => i.widens).length,
          applied: viaResult.applied.applied,
          failed: viaResult.applied.failed,
          skipped: viaResult.applied.skipped.length,
          items: items.slice(0, AUDIT_ITEM_CAP).map((i) => ({
            channelId: i.channelId,
            action: i.action,
            state: i.state ?? null,
            previousState: i.previousState,
            from: i.ledger?.from ?? null,
            to: i.ledger ? { classification: i.ledger.to.classification, mixed: i.ledger.to.mixed } : null,
            basis: i.ledger?.auto.basis ?? null,
          })),
          itemsTruncated: items.length > AUDIT_ITEM_CAP,
        },
      }).catch(() => undefined);
    }
    base.vias.push(viaResult);
  }
  return base;
}

export function countByAction(items: ReconcileItem[]): Record<ReconcileAction, number> {
  const counts: Record<ReconcileAction, number> = { add: 0, classify: 0, stricter: 0, in_scope: 0, out_of_scope: 0, leave: 0 };
  for (const i of items) counts[i.action] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Cron (/api/cron/channel-scope-reconcile, every 6 h)
// ---------------------------------------------------------------------------

export interface ReconcileCronResult {
  ok: boolean;
  skipped?: "flag_off";
  runId: string;
  orgs: number;
  employees: { reconciled: number; skippedRegisteredOnly: number; skippedOther: number; failed: number };
  items: number;
  applied: number;
  truncatedByTimeBudget: boolean;
  incompleteListings: number;
}

export const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Route maxDuration is 60 s; leave headroom for the response. */
export const RECONCILE_CRON_TIME_BUDGET_MS = 45_000;

export async function runChannelScopeReconcileCron(
  opts: {
    now?: () => number;
    timeBudgetMs?: number;
    orgConcurrency?: number;
    deps?: Omit<ReconcileDeps, "limiter" | "botListingCache">;
    limiterFactory?: () => SlackRateLimiter;
  } = {}
): Promise<ReconcileCronResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const runId = `cron-${new Date(started).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const result: ReconcileCronResult = {
    ok: true,
    runId,
    orgs: 0,
    employees: { reconciled: 0, skippedRegisteredOnly: 0, skippedOther: 0, failed: 0 },
    items: 0,
    applied: 0,
    truncatedByTimeBudget: false,
    incompleteListings: 0,
  };
  if (!isChannelScopeEnabled()) return { ...result, skipped: "flag_off" };

  const identities = await listLinkedSlackIdentitiesForTeam(null);
  const byOrg = new Map<string, string[]>();
  for (const row of identities) {
    const list = byOrg.get(row.orgId) ?? [];
    if (!list.includes(row.employeeId)) list.push(row.employeeId);
    byOrg.set(row.orgId, list);
  }
  const orgIds = [...byOrg.keys()].sort();
  result.orgs = orgIds.length;
  // Rotate the starting org every run so a time-budget cut never starves the same tenants.
  const offset = orgIds.length ? Math.floor(started / RECONCILE_INTERVAL_MS) % orgIds.length : 0;
  const queue = [...orgIds.slice(offset), ...orgIds.slice(0, offset)];
  const budget = opts.timeBudgetMs ?? RECONCILE_CRON_TIME_BUDGET_MS;
  const overBudget = () => now() - started > budget;

  const runOrg = async (orgId: string) => {
    const limiter = opts.limiterFactory
      ? opts.limiterFactory()
      : createSlackRateLimiter({ sleep: opts.deps?.sleep, now, deadline: started + budget });
    const botListingCache = new Map<string, Promise<ConversationListing | null>>();
    for (const employeeId of (byOrg.get(orgId) ?? []).sort()) {
      if (overBudget()) {
        result.truncatedByTimeBudget = true;
        return;
      }
      try {
        const scope = await getEffectiveChannelScope(orgId, employeeId);
        if (scope.policy.mode !== "all_joined") {
          result.employees.skippedRegisteredOnly += 1;
          continue;
        }
        const r = await reconcileEmployeeChannelScope(
          { orgId, employeeId, dryRun: false, trigger: "cron", runId },
          { ...opts.deps, limiter, botListingCache }
        );
        if (!r.ok) {
          result.employees.skippedOther += 1;
          continue;
        }
        const reconciled = r.vias.filter((v) => v.status === "reconciled");
        if (!reconciled.length) result.employees.skippedOther += 1;
        else result.employees.reconciled += 1;
        for (const v of reconciled) {
          result.items += v.items.length;
          result.applied += v.applied?.applied ?? 0;
          if (!v.listing?.complete) result.incompleteListings += 1;
        }
      } catch {
        result.employees.failed += 1;
        await appendAuditEvent({
          orgId,
          employeeId,
          credentialId: null,
          action: "channel_scope.reconcile_failed",
          purpose: "channel_scope.reconcile",
          summary: "チャンネル範囲の照合に失敗",
          metadata: { runId, trigger: "cron" },
        }).catch(() => undefined);
      }
    }
  };

  const concurrency = Math.max(1, Math.floor(opts.orgConcurrency ?? 4));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) {
        const orgId = queue[next++];
        if (overBudget()) {
          result.truncatedByTimeBudget = true;
          return;
        }
        await runOrg(orgId);
      }
    })
  );
  return result;
}
