/**
 * P1 Channel Scope — Data access (CS1)
 *
 * Service-role only (createSupabaseAdminClient). Every query is scoped by org_id.
 * DEMO mode uses in-memory stores (tests / local).
 *
 * Flag gating (P1_CHANNEL_SCOPE_ENABLED, default OFF):
 * - getEffectiveChannelScope / evaluateChannelScope do NOT touch the DB when OFF and return
 *   registered_only / enforced=false, so this module is inert before the migration is applied.
 * - All writes throw "channel_scope_disabled" when OFF.
 * - Policy writes are re-validated here (defense in depth); approval gating is the caller's job
 *   (channelScope.patch fulfill, CS2). The DB trigger additionally blocks anon/authenticated writes.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { getOrgChannel, listOrgChannels, upsertOrgChannel } from "@/lib/data/directory";
import type { ChannelClassification } from "@/lib/types";
import type {
  AutoClassification,
  ChannelScopeChannel,
  ChannelScopeDecision,
  ChannelScopeIngressPath,
  ChannelScopePolicy,
  ChannelScopeSurface,
  EffectiveChannelScope,
  EmployeeChannelMembership,
  MembershipState,
  MembershipVia,
  OrgChannelSource,
} from "./types";
import { CHANNEL_SCOPE_SURFACES, MEMBERSHIP_STATES, MEMBERSHIP_VIAS, ORG_CHANNEL_SOURCES } from "./types";
import { validateChannelScopePolicy } from "./validate";
import {
  isChannelInScope,
  isChannelInScopeForPath,
  mergeAutoClassification,
  readChannelScopeFlags,
  resolveEffectiveChannelScope,
  type MergedClassification,
} from "./resolve";

export const SLACK_CONVERSATION_ID_RE = /^[CG][A-Z0-9]{2,63}$/;
export const MEMBERSHIP_LIST_MAX = 500;

const demoOrgPolicies = new Map<string, unknown>();
const demoEmployeeOverrides = new Map<string, unknown>();
const demoMemberships: EmployeeChannelMembership[] = [];
const demoChannelMeta = new Map<string, Partial<ChannelScopeChannel>>();

function nowIso(): string {
  return new Date().toISOString();
}

function requireEnabled(): void {
  if (!readChannelScopeFlags().enabled) throw new Error("channel_scope_disabled");
}

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("channel_scope_unavailable");
  return client;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** Raw stored org policy JSON (unvalidated). */
export async function getOrgChannelScopePolicyRaw(orgId: string): Promise<unknown | null> {
  if (!orgId) return null;
  if (isDemoMode()) return demoOrgPolicies.get(orgId) ?? null;
  const { data, error } = await admin()
    .from("orgs")
    .select("channel_scope_policy")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error("channel_scope_policy_unavailable");
  return (data as { channel_scope_policy?: unknown } | null)?.channel_scope_policy ?? null;
}

/** Raw stored employee override JSON (unvalidated). */
export async function getEmployeeChannelScopeOverrideRaw(orgId: string, employeeId: string): Promise<unknown | null> {
  if (!orgId || !employeeId) return null;
  if (isDemoMode()) return demoEmployeeOverrides.get(`${orgId}:${employeeId}`) ?? null;
  const { data, error } = await admin()
    .from("employees")
    .select("channel_scope_override")
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error("channel_scope_override_unavailable");
  return (data as { channel_scope_override?: unknown } | null)?.channel_scope_override ?? null;
}

function validatedOrThrow(policy: ChannelScopePolicy | null): ChannelScopePolicy | null {
  if (policy === null) return null;
  const result = validateChannelScopePolicy(policy);
  if (!result.ok) throw new Error("invalid_channel_scope_policy");
  return result.policy;
}

/** Set (or clear with null) the org default. Caller must have owner approval (CS2 fulfill). */
export async function setOrgChannelScopePolicy(orgId: string, policy: ChannelScopePolicy | null): Promise<boolean> {
  requireEnabled();
  if (!orgId) throw new Error("org_id_required");
  const value = validatedOrThrow(policy);
  if (isDemoMode()) {
    if (value) demoOrgPolicies.set(orgId, value);
    else demoOrgPolicies.delete(orgId);
    return true;
  }
  const { data, error } = await admin()
    .from("orgs")
    .update({ channel_scope_policy: value })
    .eq("id", orgId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error("channel_scope_policy_write_failed");
  return Boolean(data);
}

/** Set (or clear with null) an employee override. Scoped by org_id. */
export async function setEmployeeChannelScopeOverride(
  orgId: string,
  employeeId: string,
  policy: ChannelScopePolicy | null
): Promise<boolean> {
  requireEnabled();
  if (!orgId || !employeeId) throw new Error("employee_id_required");
  const value = validatedOrThrow(policy);
  if (isDemoMode()) {
    const key = `${orgId}:${employeeId}`;
    if (value) demoEmployeeOverrides.set(key, value);
    else demoEmployeeOverrides.delete(key);
    return true;
  }
  const { data, error } = await admin()
    .from("employees")
    .update({ channel_scope_override: value })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error("channel_scope_override_write_failed");
  return Boolean(data);
}

/**
 * Effective scope: employee override → org default → registered_only.
 * Flag OFF ⇒ registered_only without any DB read.
 */
export async function getEffectiveChannelScope(orgId: string, employeeId?: string | null): Promise<EffectiveChannelScope> {
  const flags = readChannelScopeFlags();
  if (!flags.enabled) return resolveEffectiveChannelScope({ flags });
  const [employeeOverride, orgPolicy] = await Promise.all([
    employeeId ? getEmployeeChannelScopeOverrideRaw(orgId, employeeId) : Promise.resolve(null),
    getOrgChannelScopePolicyRaw(orgId),
  ]);
  return resolveEffectiveChannelScope({ employeeOverride, orgPolicy, flags });
}

// ---------------------------------------------------------------------------
// org_channels (scope columns, read-only in CS1)
// ---------------------------------------------------------------------------

function isClass(v: unknown): v is ChannelClassification {
  return v === "internal" || v === "shared_external" || v === "unknown";
}

function mapScopeChannel(row: Record<string, unknown>): ChannelScopeChannel {
  const source = ORG_CHANNEL_SOURCES.includes(row.source as OrgChannelSource)
    ? (row.source as OrgChannelSource)
    : // Unrecognized provenance is treated as automatic (not human) — fail-closed.
      "reconcile";
  return {
    externalId: String(row.external_id ?? ""),
    classification: isClass(row.classification) ? row.classification : "unknown",
    mixed: Boolean(row.mixed),
    source,
    slackTeamId: row.slack_team_id != null ? String(row.slack_team_id) : null,
    externalTeamIds: Array.isArray(row.external_team_ids) ? row.external_team_ids.map(String) : [],
    humanConfirmedAt: row.human_confirmed_at != null ? String(row.human_confirmed_at) : null,
    lastInspectedAt: row.last_inspected_at != null ? String(row.last_inspected_at) : null,
  };
}

/** org_channels row with CS1 scope columns. Requires the channel_scope migration (flag ON only). */
export async function getChannelScopeChannel(
  orgId: string,
  surface: ChannelScopeSurface,
  externalId: string
): Promise<ChannelScopeChannel | null> {
  const id = externalId.trim();
  if (!orgId || !id) return null;
  if (isDemoMode()) {
    const row = await getOrgChannel(orgId, surface, id);
    if (!row) return null;
    return {
      externalId: row.externalId,
      classification: row.classification,
      mixed: row.mixed,
      source: "manual",
      externalTeamIds: [],
      humanConfirmedAt: null,
      ...demoChannelMeta.get(`${orgId}:${surface}:${id}`),
    };
  }
  const { data, error } = await admin()
    .from("org_channels")
    .select("external_id, classification, mixed, source, slack_team_id, external_team_ids, human_confirmed_at, last_inspected_at")
    .eq("org_id", orgId)
    .eq("surface", surface)
    .eq("external_id", id)
    .maybeSingle();
  if (error) throw new Error("channel_scope_channel_unavailable");
  return data ? mapScopeChannel(data as Record<string, unknown>) : null;
}

/** org_channels rows (scope columns) for the given external ids. Flag ON callers only. */
export async function listChannelScopeChannels(
  orgId: string,
  surface: ChannelScopeSurface,
  externalIds: string[]
): Promise<ChannelScopeChannel[]> {
  const ids = [...new Set(externalIds.map((x) => x.trim()).filter(Boolean))].slice(0, MEMBERSHIP_LIST_MAX);
  if (!orgId || ids.length === 0) return [];
  if (isDemoMode()) {
    const out: ChannelScopeChannel[] = [];
    for (const id of ids) {
      const row = await getChannelScopeChannel(orgId, surface, id);
      if (row) out.push(row);
    }
    return out;
  }
  const { data, error } = await admin()
    .from("org_channels")
    .select("external_id, classification, mixed, source, slack_team_id, external_team_ids, human_confirmed_at, last_inspected_at")
    .eq("org_id", orgId)
    .eq("surface", surface)
    .in("external_id", ids);
  if (error) throw new Error("channel_scope_channel_unavailable");
  return (data ?? []).map((row) => mapScopeChannel(row as Record<string, unknown>));
}

/**
 * Auto-registered Connect channels a human has not confirmed yet (sends stay approval-gated).
 * Flag ON callers only.
 */
export async function listUnconfirmedConnectChannels(orgId: string, limit = 100): Promise<ChannelScopeChannel[]> {
  if (!orgId) return [];
  const cap = Math.min(Math.max(1, Math.floor(limit)), MEMBERSHIP_LIST_MAX);
  const isUnconfirmedConnect = (c: ChannelScopeChannel) =>
    (c.classification === "shared_external" || c.mixed) &&
    (c.source ?? "manual") !== "manual" &&
    !c.humanConfirmedAt;
  if (isDemoMode()) {
    const rows = await listOrgChannels(orgId);
    const out: ChannelScopeChannel[] = [];
    for (const row of rows) {
      if (row.surface !== "slack") continue;
      const scoped = await getChannelScopeChannel(orgId, "slack", row.externalId);
      if (scoped && isUnconfirmedConnect(scoped)) out.push(scoped);
    }
    return out.slice(0, cap);
  }
  const { data, error } = await admin()
    .from("org_channels")
    .select("external_id, classification, mixed, source, slack_team_id, external_team_ids, human_confirmed_at, last_inspected_at")
    .eq("org_id", orgId)
    .eq("surface", "slack")
    .neq("source", "manual")
    .is("human_confirmed_at", null)
    .or("classification.eq.shared_external,mixed.eq.true")
    .limit(cap);
  if (error) throw new Error("channel_scope_channel_unavailable");
  return (data ?? []).map((row) => mapScopeChannel(row as Record<string, unknown>)).filter(isUnconfirmedConnect);
}

export interface AutoChannelWriteResult {
  channel: ChannelScopeChannel;
  merged: MergedClassification;
  created: boolean;
  /** The row became Connect-like, so an earlier human confirmation (of a non-Connect state) was cleared. */
  confirmationCleared: boolean;
}

const SCOPE_CHANNEL_COLUMNS =
  "external_id, classification, mixed, source, slack_team_id, external_team_ids, human_confirmed_at, last_inspected_at";

/**
 * CS3: write an automatic classification (member_joined / channel_shared / reconcile) into
 * org_channels. Stricter-only via mergeAutoClassification:
 * - shared_external / mixed is sticky; unknown never overwrites; external teams only grow.
 * - New rows get source=auto (never 'manual'); existing rows keep their source and
 *   human_confirmed_at (a human row stays human, but may still become stricter).
 * - Exception: when a row becomes Connect-like (shared_external / mixed) for the first time, a
 *   human_confirmed_at given for the earlier, non-Connect state is cleared, so a human has to
 *   confirm the new state again (sends stay gated until then, CS4).
 * - Production: compare-and-set on (classification, mixed) with one retry, so a concurrent
 *   human/auto write is re-merged instead of overwritten.
 */
export async function upsertAutoClassifiedChannel(input: {
  orgId: string;
  surface?: ChannelScopeSurface;
  externalId: string;
  auto: Pick<AutoClassification, "classification" | "mixed" | "externalTeamIds"> & { slackTeamId?: string | null };
  source: Exclude<OrgChannelSource, "manual">;
  at?: string;
}): Promise<AutoChannelWriteResult> {
  requireEnabled();
  const surface = input.surface ?? "slack";
  const externalId = (input.externalId ?? "").trim();
  if (!input.orgId) throw new Error("org_id_required");
  if (!CHANNEL_SCOPE_SURFACES.includes(surface)) throw new Error("invalid_surface");
  if (!SLACK_CONVERSATION_ID_RE.test(externalId)) throw new Error("invalid_external_id");
  if (!ORG_CHANNEL_SOURCES.includes(input.source) || (input.source as string) === "manual") {
    throw new Error("invalid_auto_source");
  }
  const at = input.at ?? nowIso();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await getChannelScopeChannel(input.orgId, surface, externalId);
    const merged = mergeAutoClassification(existing, input.auto);
    const slackTeamId = existing?.slackTeamId ?? input.auto.slackTeamId ?? null;
    const wasConnect = Boolean(existing && (existing.classification === "shared_external" || existing.mixed));
    const isConnect = merged.classification === "shared_external" || merged.mixed;
    const confirmationCleared = Boolean(existing?.humanConfirmedAt) && !wasConnect && isConnect;
    const humanConfirmedAt = confirmationCleared ? null : existing?.humanConfirmedAt ?? null;

    if (isDemoMode()) {
      if (!existing || merged.changed) {
        await upsertOrgChannel({
          orgId: input.orgId,
          surface,
          externalId,
          classification: merged.classification,
          mixed: merged.mixed,
          skipInspect: true,
        });
      }
      const key = `${input.orgId}:${surface}:${externalId}`;
      const prevMeta = demoChannelMeta.get(key) ?? {};
      demoChannelMeta.set(key, {
        ...prevMeta,
        source: existing ? existing.source ?? "manual" : input.source,
        slackTeamId,
        externalTeamIds: merged.externalTeamIds,
        humanConfirmedAt,
        lastInspectedAt: at,
      });
      const channel = (await getChannelScopeChannel(input.orgId, surface, externalId))!;
      return { channel, merged, created: !existing, confirmationCleared };
    }

    const client = admin();
    if (!existing) {
      const { data, error } = await client
        .from("org_channels")
        .upsert(
          {
            org_id: input.orgId,
            surface,
            external_id: externalId,
            classification: merged.classification,
            mixed: merged.mixed,
            source: input.source,
            slack_team_id: slackTeamId,
            external_team_ids: merged.externalTeamIds,
            last_inspected_at: at,
            updated_at: at,
          },
          { onConflict: "org_id,surface,external_id", ignoreDuplicates: true }
        )
        .select(SCOPE_CHANNEL_COLUMNS);
      if (error) throw new Error("channel_scope_channel_write_failed");
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (row) return { channel: mapScopeChannel(row), merged, created: true, confirmationCleared: false };
      continue; // created concurrently ⇒ re-merge against the stored row
    }
    const { data, error } = await client
      .from("org_channels")
      .update({
        classification: merged.classification,
        mixed: merged.mixed,
        slack_team_id: slackTeamId,
        external_team_ids: merged.externalTeamIds,
        last_inspected_at: at,
        ...(confirmationCleared ? { human_confirmed_at: null } : {}),
        ...(merged.changed ? { updated_at: at } : {}),
      })
      .eq("org_id", input.orgId)
      .eq("surface", surface)
      .eq("external_id", externalId)
      .eq("classification", existing.classification)
      .eq("mixed", existing.mixed)
      .select(SCOPE_CHANNEL_COLUMNS);
    if (error) throw new Error("channel_scope_channel_write_failed");
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (row) return { channel: mapScopeChannel(row), merged, created: false, confirmationCleared };
  }
  throw new Error("channel_scope_channel_write_conflict");
}

// ---------------------------------------------------------------------------
// employee_channel_memberships
// ---------------------------------------------------------------------------

function mapMembership(row: Record<string, unknown>): EmployeeChannelMembership {
  const str = (v: unknown) => (v != null ? String(v) : null);
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    employeeId: String(row.employee_id),
    surface: "slack",
    externalId: String(row.external_id ?? ""),
    via: row.via === "bot" ? "bot" : "user",
    state: MEMBERSHIP_STATES.includes(row.state as MembershipState) ? (row.state as MembershipState) : "out_of_scope",
    inviterSlackUserId: str(row.inviter_slack_user_id),
    inviterTeamId: str(row.inviter_team_id),
    joinedAt: str(row.joined_at),
    leftAt: str(row.left_at),
    lastEventId: str(row.last_event_id),
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

export async function listEmployeeChannelMemberships(
  orgId: string,
  filter: { employeeId?: string; externalId?: string; state?: MembershipState; limit?: number } = {}
): Promise<EmployeeChannelMembership[]> {
  if (!orgId) return [];
  const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 100)), MEMBERSHIP_LIST_MAX);
  if (filter.state !== undefined && !MEMBERSHIP_STATES.includes(filter.state)) throw new Error("invalid_membership_state");
  if (isDemoMode()) {
    return demoMemberships
      .filter(
        (m) =>
          m.orgId === orgId &&
          (!filter.employeeId || m.employeeId === filter.employeeId) &&
          (!filter.externalId || m.externalId === filter.externalId) &&
          (!filter.state || m.state === filter.state)
      )
      .slice(0, limit);
  }
  let query = admin().from("employee_channel_memberships").select("*").eq("org_id", orgId);
  if (filter.employeeId) query = query.eq("employee_id", filter.employeeId);
  if (filter.externalId) query = query.eq("external_id", filter.externalId);
  if (filter.state) query = query.eq("state", filter.state);
  const { data, error } = await query.order("updated_at", { ascending: false }).limit(limit);
  if (error) throw new Error("channel_memberships_unavailable");
  return (data ?? []).map((row) => mapMembership(row as Record<string, unknown>));
}

export interface UpsertMembershipInput {
  orgId: string;
  employeeId: string;
  surface?: ChannelScopeSurface;
  externalId: string;
  via: MembershipVia;
  state: MembershipState;
  inviterSlackUserId?: string | null;
  inviterTeamId?: string | null;
  eventId?: string | null;
  at?: string;
}

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;
const SLACK_TEAM_RE = /^[TE][A-Z0-9]{2,30}$/;
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Idempotent upsert on (employee_id, surface, external_id, via).
 * A replay of the same eventId is a no-op (returns the stored row, applied=false).
 */
export async function upsertEmployeeChannelMembership(
  input: UpsertMembershipInput
): Promise<{ membership: EmployeeChannelMembership; applied: boolean }> {
  requireEnabled();
  const surface = input.surface ?? "slack";
  const externalId = (input.externalId ?? "").trim();
  if (!input.orgId || !input.employeeId) throw new Error("employee_id_required");
  if (!CHANNEL_SCOPE_SURFACES.includes(surface)) throw new Error("invalid_surface");
  if (!SLACK_CONVERSATION_ID_RE.test(externalId)) throw new Error("invalid_external_id");
  if (!MEMBERSHIP_VIAS.includes(input.via)) throw new Error("invalid_via");
  if (!MEMBERSHIP_STATES.includes(input.state)) throw new Error("invalid_membership_state");
  if (input.inviterSlackUserId && !SLACK_USER_ID_RE.test(input.inviterSlackUserId)) throw new Error("invalid_inviter_user_id");
  if (input.inviterTeamId && !SLACK_TEAM_RE.test(input.inviterTeamId)) throw new Error("invalid_inviter_team_id");
  if (input.eventId && !EVENT_ID_RE.test(input.eventId)) throw new Error("invalid_event_id");
  const at = input.at ?? nowIso();

  const existing = (
    await listEmployeeChannelMemberships(input.orgId, { employeeId: input.employeeId, externalId, limit: 10 })
  ).find((m) => m.via === input.via && m.surface === surface);
  if (existing && input.eventId && existing.lastEventId === input.eventId) {
    return { membership: existing, applied: false };
  }
  const joining = input.state === "member" || input.state === "out_of_scope";
  const next = {
    joinedAt: joining ? (existing?.joinedAt && existing.state !== "left" && existing.state !== "removed" ? existing.joinedAt : at) : existing?.joinedAt ?? null,
    leftAt: joining ? null : at,
  };
  if (isDemoMode()) {
    if (existing) {
      Object.assign(existing, {
        state: input.state,
        inviterSlackUserId: input.inviterSlackUserId ?? existing.inviterSlackUserId,
        inviterTeamId: input.inviterTeamId ?? existing.inviterTeamId,
        joinedAt: next.joinedAt,
        leftAt: next.leftAt,
        lastEventId: input.eventId ?? existing.lastEventId,
        updatedAt: at,
      });
      return { membership: existing, applied: true };
    }
    const row: EmployeeChannelMembership = {
      id: `ecm_${Math.random().toString(36).slice(2, 10)}`,
      orgId: input.orgId,
      employeeId: input.employeeId,
      surface,
      externalId,
      via: input.via,
      state: input.state,
      inviterSlackUserId: input.inviterSlackUserId ?? null,
      inviterTeamId: input.inviterTeamId ?? null,
      joinedAt: next.joinedAt,
      leftAt: next.leftAt,
      lastEventId: input.eventId ?? null,
      createdAt: at,
      updatedAt: at,
    };
    demoMemberships.unshift(row);
    return { membership: row, applied: true };
  }
  const { data, error } = await admin()
    .from("employee_channel_memberships")
    .upsert(
      {
        org_id: input.orgId,
        employee_id: input.employeeId,
        surface,
        external_id: externalId,
        via: input.via,
        state: input.state,
        inviter_slack_user_id: input.inviterSlackUserId ?? existing?.inviterSlackUserId ?? null,
        inviter_team_id: input.inviterTeamId ?? existing?.inviterTeamId ?? null,
        joined_at: next.joinedAt,
        left_at: next.leftAt,
        last_event_id: input.eventId ?? existing?.lastEventId ?? null,
        updated_at: at,
      },
      { onConflict: "employee_id,surface,external_id,via" }
    )
    .select("*")
    .single();
  if (error || !data) throw new Error("channel_membership_write_failed");
  return { membership: mapMembership(data as Record<string, unknown>), applied: true };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Is the channel in scope for this employee? Flag OFF ⇒ enforced=false with no DB access
 * (callers keep legacy checks). Lookup errors ⇒ enforced, out of scope (fail-closed).
 */
export async function evaluateChannelScope(input: {
  orgId: string;
  employeeId: string;
  surface: ChannelScopeSurface;
  externalId: string;
  /** CS3: ingress path. Omitted ⇒ strict isChannelInScope (same as user_token_channel). */
  path?: ChannelScopeIngressPath;
}): Promise<ChannelScopeDecision> {
  const flags = readChannelScopeFlags();
  const decideFor = (args: Parameters<typeof isChannelInScope>[0]) =>
    input.path ? isChannelInScopeForPath({ ...args, path: input.path }) : isChannelInScope(args);
  if (!flags.enabled) {
    const scope = resolveEffectiveChannelScope({ flags });
    return decideFor({ scope, surface: input.surface, externalId: input.externalId, channel: null });
  }
  try {
    const scope = await getEffectiveChannelScope(input.orgId, input.employeeId);
    const [channel, memberships] = await Promise.all([
      getChannelScopeChannel(input.orgId, input.surface, input.externalId),
      scope.policy.mode === "all_joined"
        ? listEmployeeChannelMemberships(input.orgId, {
            employeeId: input.employeeId,
            externalId: input.externalId.trim(),
            limit: 10,
          })
        : Promise.resolve([]),
    ]);
    return decideFor({ scope, surface: input.surface, externalId: input.externalId, channel, memberships });
  } catch {
    return { enforced: true, inScope: false, reason: "lookup_failed", mode: "registered_only", source: "default" };
  }
}

// ---------------------------------------------------------------------------
// Test helpers (DEMO mode only)
// ---------------------------------------------------------------------------

export function __resetChannelScopeDemoStore(): void {
  demoOrgPolicies.clear();
  demoEmployeeOverrides.clear();
  demoMemberships.length = 0;
  demoChannelMeta.clear();
}

/** DEMO only: overlay CS1 scope columns onto an in-memory org_channels row. */
export function __setDemoChannelScopeMeta(
  orgId: string,
  surface: ChannelScopeSurface,
  externalId: string,
  meta: Partial<ChannelScopeChannel>
): void {
  if (!isDemoMode()) throw new Error("demo_only");
  demoChannelMeta.set(`${orgId}:${surface}:${externalId}`, meta);
}

/** DEMO only: store a raw (possibly invalid) policy to exercise fail-closed resolution. */
export function __setDemoRawPolicies(orgId: string, input: { org?: unknown; employeeId?: string; employee?: unknown }): void {
  if (!isDemoMode()) throw new Error("demo_only");
  if (input.org !== undefined) demoOrgPolicies.set(orgId, input.org);
  if (input.employeeId && input.employee !== undefined) demoEmployeeOverrides.set(`${orgId}:${input.employeeId}`, input.employee);
}
