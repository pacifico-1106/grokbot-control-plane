/**
 * P1 Channel Scope — Pure resolution logic (CS1)
 *
 * No I/O. Data access lives in ./data.ts.
 *
 * Resolution order: employee override → org default → safe default (registered_only).
 * Flags: P1_CHANNEL_SCOPE_ENABLED OFF ⇒ registered_only and decisions are not enforced.
 *        P1_CHANNEL_SCOPE_CONNECT_ENABLED OFF ⇒ includeSlackConnect forced false.
 *
 * Fail-closed rules:
 * - An invalid stored policy at any layer resolves to the safe default (never falls through to a
 *   possibly wider layer).
 * - Automatic classification only moves a channel to a stricter state.
 */
import { isChannelScopeConnectEnabled, isChannelScopeEnabled } from "@/lib/feature-flags";
import type { ChannelClassification } from "@/lib/types";
import type {
  AutoClassification,
  ChannelScopeChannel,
  ChannelScopeDecision,
  ChannelScopeFlags,
  ChannelScopeIngressPath,
  ChannelScopePolicy,
  ChannelScopeSource,
  ChannelScopeSurface,
  EffectiveChannelScope,
  EmployeeChannelMembership,
  SlackConversationInfoLike,
} from "./types";
import { defaultChannelScopePolicy, SLACK_TEAM_ID_RE, validateChannelScopePolicy } from "./validate";

export function readChannelScopeFlags(): ChannelScopeFlags {
  return { enabled: isChannelScopeEnabled(), connectEnabled: isChannelScopeConnectEnabled() };
}

/**
 * Resolve the effective policy from raw stored JSON (employees.channel_scope_override,
 * orgs.channel_scope_policy). Raw values are re-validated here.
 */
export function resolveEffectiveChannelScope(input: {
  employeeOverride?: unknown;
  orgPolicy?: unknown;
  flags?: ChannelScopeFlags;
}): EffectiveChannelScope {
  const flags = input.flags ?? readChannelScopeFlags();
  const safe = (source: ChannelScopeSource, invalidStoredPolicy = false): EffectiveChannelScope => ({
    policy: defaultChannelScopePolicy(),
    source,
    flags,
    connectSuppressed: false,
    invalidStoredPolicy,
  });
  if (!flags.enabled) return safe("default");

  let chosen: ChannelScopePolicy | null = null;
  let source: ChannelScopeSource = "default";
  for (const [layer, raw] of [
    ["employee", input.employeeOverride],
    ["org", input.orgPolicy],
  ] as const) {
    if (raw === null || raw === undefined) continue;
    const result = validateChannelScopePolicy(raw);
    if (!result.ok) return safe("default", true);
    chosen = result.policy;
    source = layer;
    break;
  }
  if (!chosen) return safe("default");

  let connectSuppressed = false;
  const policy: ChannelScopePolicy = { ...chosen, connect: { ...chosen.connect } };
  if (policy.mode !== "all_joined" && policy.includeSlackConnect) {
    // validate already rejects this; keep the invariant even if called with a hand-built object.
    policy.includeSlackConnect = false;
  }
  if (policy.includeSlackConnect && !flags.connectEnabled) {
    policy.includeSlackConnect = false;
    connectSuppressed = true;
  }
  return { policy, source, flags, connectSuppressed, invalidStoredPolicy: false };
}

/** A channel counts as registered when a human put it in the ledger (or confirmed it). */
export function isRegisteredChannel(channel: ChannelScopeChannel | null | undefined): boolean {
  if (!channel) return false;
  if (channel.classification === "unknown") return false;
  const source = channel.source ?? "manual";
  return source === "manual" || Boolean(channel.humanConfirmedAt);
}

function isConnectLike(channel: ChannelScopeChannel): boolean {
  return channel.classification === "shared_external" || channel.mixed;
}

/** allowlist empty ⇒ any team; otherwise every known peer team must be allowed (unknown peers ⇒ not allowed). */
export function isConnectTeamAllowed(policy: ChannelScopePolicy, externalTeamIds: string[] | null | undefined): boolean {
  const allow = policy.connect.allowedExternalTeamIds;
  if (!allow.length) return true;
  const teams = (externalTeamIds ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!teams.length) return false;
  return teams.every((t) => allow.includes(t));
}

/**
 * Is this channel in scope for the employee? Pure; the caller supplies the channel row and the
 * employee's membership rows (any via) for this channel.
 *
 * - registered_only: org_channels row exists, classified, and source=manual or human-confirmed.
 *   Memberships are ignored (today's behavior).
 * - all_joined: registered channels stay in scope unless the employee left / was removed;
 *   otherwise membership=member and classification internal (non-mixed).
 * - all_joined + includeSlackConnect: additionally shared_external / mixed, subject to
 *   connect.allowedExternalTeamIds.
 */
export function isChannelInScope(input: {
  scope: EffectiveChannelScope;
  surface: ChannelScopeSurface | string;
  externalId: string;
  channel: ChannelScopeChannel | null | undefined;
  memberships?: Pick<EmployeeChannelMembership, "surface" | "externalId" | "state" | "via">[];
}): ChannelScopeDecision {
  const { scope } = input;
  const mode = scope.policy.mode;
  const base = { mode, source: scope.source };
  if (!scope.flags.enabled) {
    return { ...base, enforced: false, inScope: true, reason: "flag_off_legacy" };
  }
  const decide = (inScope: boolean, reason: ChannelScopeDecision["reason"]): ChannelScopeDecision => ({
    ...base,
    enforced: true,
    inScope,
    reason,
  });
  if (!scope.policy.surfaces.includes(input.surface as ChannelScopeSurface)) {
    return decide(false, "surface_not_in_scope");
  }
  const channel = input.channel ?? null;
  const registered = isRegisteredChannel(channel);

  if (mode === "registered_only") {
    if (!channel) return decide(false, "not_registered");
    if (channel.classification === "unknown") return decide(false, "registered_unclassified");
    return registered ? decide(true, "registered") : decide(false, "auto_not_confirmed");
  }

  // all_joined
  const externalId = input.externalId.trim();
  const rows = (input.memberships ?? []).filter(
    (m) => m.surface === input.surface && m.externalId === externalId
  );
  const isMember = rows.some((m) => m.state === "member");
  const hasLeft = rows.some((m) => m.state === "left" || m.state === "removed");
  if (!isMember && hasLeft) return decide(false, "membership_left");
  if (registered) return decide(true, "registered");
  if (!isMember) return decide(false, "not_member");
  if (!channel || channel.classification === "unknown") return decide(false, "classification_unknown");
  if (!isConnectLike(channel)) return decide(true, "joined_internal");
  if (!scope.policy.includeSlackConnect) return decide(false, "connect_not_included");
  if (!isConnectTeamAllowed(scope.policy, channel.externalTeamIds)) return decide(false, "connect_team_not_allowed");
  return decide(true, "joined_connect");
}

/**
 * CS3: ingress-path aware decision.
 *
 * - user_token_channel (DL-2 path): exactly isChannelInScope.
 * - bot_channel (app_mention / bot message in a channel): today this path has no ledger
 *   requirement, and registered_only promises "today's behavior". So under registered_only the
 *   bot path stays legacy-allowed, EXCEPT channels that only automatic classification put in the
 *   ledger (source≠manual, not human-confirmed). Those rows only exist because of all_joined, so
 *   switching back to registered_only takes them out of scope again. all_joined uses the full
 *   isChannelInScope (left/removed, Connect exclusion, unknown ⇒ out).
 */
export function isChannelInScopeForPath(
  input: Parameters<typeof isChannelInScope>[0] & { path: ChannelScopeIngressPath }
): ChannelScopeDecision {
  const decision = isChannelInScope(input);
  if (!decision.enforced || input.path !== "bot_channel" || decision.mode !== "registered_only") {
    return decision;
  }
  if (decision.inScope || decision.reason === "surface_not_in_scope") return decision;
  const channel = input.channel ?? null;
  const autoOnly = Boolean(channel && (channel.source ?? "manual") !== "manual" && !channel.humanConfirmedAt);
  if (autoOnly) return { ...decision, inScope: false, reason: "auto_not_confirmed" };
  return { ...decision, inScope: true, reason: "bot_path_legacy" };
}

function normTeam(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return SLACK_TEAM_ID_RE.test(t) ? t : null;
}

function teamList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(normTeam).filter((t): t is string => Boolean(t)))];
}

/**
 * Classify a Slack conversation from conversations.info (CS3 caller). Fail-closed:
 * - null / API failure / missing flags ⇒ unknown
 * - ext shared or pending ext shared, or any connected team outside the IAR ⇒ shared_external + mixed
 * - org-shared (Enterprise Grid) ⇒ internal only if home + all connected teams are IAR teams, else unknown
 * - not shared and home team ∈ IAR slackTeamIds ⇒ internal; otherwise unknown
 */
export function classifySlackConversation(
  info: SlackConversationInfoLike | null | undefined,
  internalSlackTeamIds: string[]
): AutoClassification {
  const internal = new Set(teamList(internalSlackTeamIds));
  const home = normTeam(info?.context_team_id);
  const connected = teamList([...(info?.connected_team_ids ?? []), ...(info?.pending_connected_team_ids ?? [])]);
  const peers = connected.filter((t) => t !== home);
  const result = (
    classification: ChannelClassification,
    basis: AutoClassification["basis"]
  ): AutoClassification => ({
    classification,
    mixed: classification === "shared_external",
    slackTeamId: home,
    externalTeamIds: classification === "shared_external" ? peers.filter((t) => !internal.has(t)) : [],
    basis,
  });
  if (!info || typeof info.is_ext_shared !== "boolean") return result("unknown", "api_failed");
  if (info.is_ext_shared) return result("shared_external", "ext_shared");
  if (info.is_pending_ext_shared === true) return result("shared_external", "pending_ext_shared");
  if (peers.some((t) => !internal.has(t))) return result("shared_external", "foreign_connected_team");
  if (info.is_org_shared === true || info.is_shared === true) {
    return home && internal.has(home) && peers.every((t) => internal.has(t))
      ? result("internal", "org_shared_internal_teams")
      : result("unknown", "org_shared_unverified");
  }
  if (home && internal.has(home)) return result("internal", "home_team_internal");
  return result("unknown", "home_team_not_registered");
}

export interface MergedClassification {
  classification: ChannelClassification;
  mixed: boolean;
  externalTeamIds: string[];
  changed: boolean;
  /** An automatic result tried to widen the channel (e.g. shared → internal) and was ignored. */
  rejectedWidening: boolean;
}

/**
 * Merge an automatic classification into an existing org_channels row: stricter-only.
 * - shared_external / mixed is sticky (never back to internal or unknown).
 * - unknown (API failure) never overwrites an existing classification.
 * - unknown → internal is allowed only for rows a human has not confirmed.
 * - mixed and externalTeamIds only grow.
 */
export function mergeAutoClassification(
  existing: Pick<ChannelScopeChannel, "classification" | "mixed" | "externalTeamIds" | "humanConfirmedAt"> | null,
  next: Pick<AutoClassification, "classification" | "mixed" | "externalTeamIds">
): MergedClassification {
  const nextTeams = teamList(next.externalTeamIds);
  if (!existing) {
    return {
      classification: next.classification,
      mixed: next.mixed || next.classification === "shared_external",
      externalTeamIds: nextTeams,
      changed: true,
      rejectedWidening: false,
    };
  }
  const prevTeams = teamList(existing.externalTeamIds ?? []);
  const teams = [...new Set([...prevTeams, ...nextTeams])];
  const prevConnect = existing.classification === "shared_external" || existing.mixed;
  let classification = existing.classification;
  let rejectedWidening = false;
  if (next.classification === "shared_external") {
    classification = "shared_external";
  } else if (next.classification === "internal") {
    if (prevConnect || (existing.classification === "unknown" && existing.humanConfirmedAt)) {
      rejectedWidening = true;
    } else {
      classification = "internal";
    }
  }
  const mixed = existing.mixed || next.mixed || classification === "shared_external";
  const changed =
    classification !== existing.classification ||
    mixed !== existing.mixed ||
    teams.length !== prevTeams.length;
  return { classification, mixed, externalTeamIds: teams, changed, rejectedWidening };
}
