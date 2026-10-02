/**
 * P1 Channel Scope — CS3 Slack channel membership ingress.
 *
 * Handles member_joined_channel / member_left_channel / channel_left / group_left /
 * channel_shared / channel_unshared, delivered through the existing Events endpoint
 * (app/api/webhooks/slack/events → processSlackMentionEnvelope → here).
 *
 * Flag: P1_CHANNEL_SCOPE_ENABLED (default OFF). The caller only routes here when the flag is ON;
 * when OFF these event types keep today's `unsupported_event_type` behavior (no claim, no DB).
 *
 * Security / fail-closed rules (design §4):
 * - Idempotent: the Slack event_id is claimed first (slack_mention_events). A replay is a no-op;
 *   membership rows additionally remember last_event_id.
 * - Only the AI employee's own joins are recorded. The joiner must be an authorization of this
 *   delivery (authorizations[].user_id === event.user):
 *     - user token (is_bot=false): resolved through employee_slack_identities (explicit map only);
 *     - bot token  (is_bot=true): the org's enabled Slack adapter for that team, exactly one org,
 *       recorded as via=bot for that org's linked employees in the team.
 *   Anyone else's join/leave is ignored and not stored.
 * - registered_only ⇒ only record (state=out_of_scope) and audit; no conversations.info call.
 * - all_joined ⇒ conversations.info (user token first, else bot token) → classifySlackConversation
 *   with the IAR slackTeamIds. API failure ⇒ unknown (out of scope at wake time).
 * - Classification is written stricter-only (upsertAutoClassifiedChannel). channel_shared makes a
 *   channel shared_external immediately, even when a human confirmed it (that confirmation is
 *   cleared, so a human must confirm the Connect state again); channel_unshared never widens it
 *   back automatically. Rows a human created (source=manual) stay registered, as in CS1.
 * - Connect channels the policy does not include are recorded as out_of_scope.
 * - No message bodies are read or stored.
 *
 * Not in CS3: approver info card on Connect invites (CS4), reconcile cron (CS5).
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getEnabledConversationAdapter } from "@/lib/data/conversation-adapters";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import {
  getEmployeesBySlackUserIds,
  getLinkedSlackUserToken,
  listLinkedSlackIdentitiesForTeam,
} from "@/lib/data/slack-identities";
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import {
  getEffectiveChannelScope,
  listEmployeeChannelMemberships,
  SLACK_CONVERSATION_ID_RE,
  upsertAutoClassifiedChannel,
  upsertEmployeeChannelMembership,
} from "@/lib/channel-scope/data";
import { classifySlackConversation, isChannelInScope } from "@/lib/channel-scope/resolve";
import type {
  AutoClassification,
  ChannelScopeChannel,
  EffectiveChannelScope,
  MembershipState,
  MembershipVia,
  SlackConversationInfoLike,
} from "@/lib/channel-scope/types";
import { SLACK_TEAM_ID_RE } from "@/lib/channel-scope/validate";

export const CHANNEL_MEMBERSHIP_EVENT_TYPES = [
  "member_joined_channel",
  "member_left_channel",
  "channel_left",
  "group_left",
  "channel_shared",
  "channel_unshared",
] as const;

export type ChannelMembershipEventType = (typeof CHANNEL_MEMBERSHIP_EVENT_TYPES)[number];

export function isChannelMembershipEventType(value: string): value is ChannelMembershipEventType {
  return (CHANNEL_MEMBERSHIP_EVENT_TYPES as readonly string[]).includes(value);
}

type Auth = { is_bot?: boolean | string; user_id?: string; team_id?: string };

export type ChannelMembershipEnvelope = {
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    user?: string;
    channel?: string | { id?: string };
    channel_type?: string;
    team?: string;
    inviter?: string;
    actor_id?: string;
    connected_team_id?: string;
    previously_connected_team_id?: string;
  };
  authorizations?: Auth[];
};

export type ChannelMembershipOutcome = {
  handled: boolean;
  woke: 0;
  duplicate?: boolean;
  skipReason?: string;
  channelMembership?: {
    eventType: ChannelMembershipEventType;
    subjects: number;
    applied: number;
    failed: number;
  };
};

export type ChannelMembershipDeps = {
  /** Event-id claim (processSlackMentionEnvelope passes claimSlackMentionEvent). */
  claim: (eventId: string) => Promise<boolean>;
  /** conversations.info; null on any failure. Overridable for tests. */
  fetchConversationInfo?: (token: string, channelId: string) => Promise<SlackConversationInfoLike | null>;
};

const SLACK_TIMEOUT_MS = 5_000;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function channelIdOf(event: ChannelMembershipEnvelope["event"]): string {
  const raw = event?.channel;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") return str(raw.id);
  return "";
}

function upper(v: string): string {
  return v.toUpperCase();
}

function teamOrNull(v: unknown): string | null {
  const t = upper(str(v));
  return SLACK_TEAM_ID_RE.test(t) ? t : null;
}

function userOrNull(v: unknown): string | null {
  const u = upper(str(v));
  return SLACK_USER_ID_RE.test(u) ? u : null;
}

function viaOf(auth: Auth): MembershipVia | null {
  if (auth.is_bot === true || auth.is_bot === "true") return "bot";
  if (auth.is_bot === false || auth.is_bot === "false") return "user";
  return null;
}

/** Default conversations.info fetcher. Never throws; never logs the token. */
export async function fetchSlackConversationInfo(
  token: string,
  channelId: string
): Promise<SlackConversationInfoLike | null> {
  if (!token || !channelId) return null;
  try {
    const url = `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; channel?: Record<string, unknown> };
    if (!body.ok || !body.channel) return null;
    const c = body.channel;
    const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
    return {
      is_ext_shared: bool(c.is_ext_shared),
      is_pending_ext_shared: bool(c.is_pending_ext_shared),
      is_shared: bool(c.is_shared),
      is_org_shared: bool(c.is_org_shared),
      context_team_id: typeof c.context_team_id === "string" ? c.context_team_id : null,
      connected_team_ids: list(c.connected_team_ids),
      pending_connected_team_ids: list(c.pending_connected_team_ids),
    };
  } catch {
    return null;
  }
}

/** One AI employee whose membership this delivery is about. */
type Subject = {
  orgId: string;
  employeeId: string;
  via: MembershipVia;
  slackUserId: string;
  teamId: string;
};

type SubjectResolution = { subjects: Subject[]; reason?: string };

/**
 * Resolve the AI employee(s) the delivery's authorization belongs to.
 * - user: explicit identity map (employee_slack_identities, linked, same team).
 * - bot: linked identities in the team, which must all be in ONE org that has an enabled Slack
 *   adapter for that team (config.teamId must match when set). Ambiguous ⇒ none.
 */
async function resolveSubjects(auth: Auth): Promise<SubjectResolution> {
  const via = viaOf(auth);
  const userId = userOrNull(auth.user_id);
  const teamId = teamOrNull(auth.team_id);
  if (!via || !userId || !teamId) return { subjects: [], reason: "authorization_invalid" };
  if (via === "user") {
    const rows = await getEmployeesBySlackUserIds([userId], teamId);
    const subjects = rows.map((r) => ({ orgId: r.orgId, employeeId: r.employeeId, via, slackUserId: userId, teamId }));
    return subjects.length ? { subjects } : { subjects: [], reason: "employee_not_bound" };
  }
  const linked = await listLinkedSlackIdentitiesForTeam(teamId);
  const orgs = [...new Set(linked.map((r) => r.orgId))];
  if (orgs.length !== 1) return { subjects: [], reason: orgs.length ? "bot_org_ambiguous" : "employee_not_bound" };
  const adapter = await getEnabledConversationAdapter(orgs[0], "slack");
  const adapterTeam = teamOrNull(adapter?.config?.teamId);
  if (!adapter || (adapterTeam && adapterTeam !== teamId)) return { subjects: [], reason: "bot_adapter_not_found" };
  return {
    subjects: linked.map((r) => ({ orgId: r.orgId, employeeId: r.employeeId, via, slackUserId: userId, teamId })),
  };
}

function audit(
  orgId: string,
  employeeId: string | null,
  action:
    | "channel_scope.auto_classified"
    | "channel_scope.membership_recorded"
    | "channel_scope.channel_shared"
    | "channel_scope.unshare_ignored"
    | "channel_scope.event_failed",
  summary: string,
  metadata: Record<string, unknown>
): Promise<void> {
  return appendAuditEvent({
    orgId,
    employeeId,
    credentialId: null,
    action,
    purpose: "channel_scope.ingress",
    summary,
    metadata,
  })
    .then(() => undefined)
    .catch(() => undefined);
}

/** Connect channel the policy does not include ⇒ out_of_scope; everything else stays member. */
function joinState(scope: EffectiveChannelScope, channel: ChannelScopeChannel, via: MembershipVia): MembershipState {
  const decision = isChannelInScope({
    scope,
    surface: "slack",
    externalId: channel.externalId,
    channel,
    memberships: [{ surface: "slack", externalId: channel.externalId, state: "member", via }],
  });
  return decision.reason === "connect_not_included" || decision.reason === "connect_team_not_allowed"
    ? "out_of_scope"
    : "member";
}

async function classifyForOrg(
  orgId: string,
  subject: Subject,
  channelId: string,
  fetchInfo: NonNullable<ChannelMembershipDeps["fetchConversationInfo"]>
): Promise<AutoClassification> {
  const userToken = subject.via === "user" ? await getLinkedSlackUserToken(subject.employeeId) : "";
  const token = userToken || (await resolveOrgSlackBotToken(orgId));
  const info = token ? await fetchInfo(token, channelId) : null;
  const rule = await getOrgInternalAudienceRule(orgId);
  return classifySlackConversation(info, rule.slackTeamIds);
}

async function handleJoin(input: {
  subjects: Subject[];
  channelId: string;
  eventId: string;
  inviter: string | null;
  joinerTeam: string | null;
  fetchInfo: NonNullable<ChannelMembershipDeps["fetchConversationInfo"]>;
}): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  const classified = new Map<
    string,
    { auto: AutoClassification; channel: ChannelScopeChannel; rejectedWidening: boolean; confirmationCleared: boolean }
  >();
  for (const subject of input.subjects) {
    try {
      const scope = await getEffectiveChannelScope(subject.orgId, subject.employeeId);
      if (scope.policy.mode === "registered_only") {
        const res = await upsertEmployeeChannelMembership({
          orgId: subject.orgId,
          employeeId: subject.employeeId,
          externalId: input.channelId,
          via: subject.via,
          state: "out_of_scope",
          inviterSlackUserId: input.inviter,
          eventId: input.eventId,
        });
        if (res.applied) applied += 1;
        await audit(subject.orgId, subject.employeeId, "channel_scope.membership_recorded", "チャンネル参加を記録（範囲外: 登録済みのみ）", {
          channelId: input.channelId,
          via: subject.via,
          state: "out_of_scope",
          reason: "registered_only",
          scopeSource: scope.source,
          inviterSlackUserId: input.inviter,
          joinerTeamId: input.joinerTeam,
          eventId: input.eventId,
        });
        continue;
      }
      let entry = classified.get(subject.orgId);
      if (!entry) {
        const auto = await classifyForOrg(subject.orgId, subject, input.channelId, input.fetchInfo);
        const written = await upsertAutoClassifiedChannel({
          orgId: subject.orgId,
          externalId: input.channelId,
          auto,
          source: "auto_join",
        });
        entry = {
          auto,
          channel: written.channel,
          rejectedWidening: written.merged.rejectedWidening,
          confirmationCleared: written.confirmationCleared,
        };
        classified.set(subject.orgId, entry);
      }
      const state = joinState(scope, entry.channel, subject.via);
      const res = await upsertEmployeeChannelMembership({
        orgId: subject.orgId,
        employeeId: subject.employeeId,
        externalId: input.channelId,
        via: subject.via,
        state,
        inviterSlackUserId: input.inviter,
        eventId: input.eventId,
      });
      if (res.applied) applied += 1;
      await audit(subject.orgId, subject.employeeId, "channel_scope.auto_classified", `チャンネル自動分類: ${entry.channel.classification}`, {
        channelId: input.channelId,
        via: subject.via,
        classification: entry.channel.classification,
        mixed: entry.channel.mixed,
        basis: entry.auto.basis,
        slackTeamId: entry.channel.slackTeamId ?? null,
        externalTeamIds: entry.channel.externalTeamIds ?? [],
        source: entry.channel.source ?? "manual",
        humanConfirmed: Boolean(entry.channel.humanConfirmedAt),
        humanConfirmationCleared: entry.confirmationCleared,
        rejectedWidening: entry.rejectedWidening,
        membershipState: state,
        mode: scope.policy.mode,
        includeSlackConnect: scope.policy.includeSlackConnect,
        connectSuppressed: scope.connectSuppressed,
        inviterSlackUserId: input.inviter,
        joinerTeamId: input.joinerTeam,
        eventId: input.eventId,
      });
    } catch (error) {
      failed += 1;
      await audit(subject.orgId, subject.employeeId, "channel_scope.event_failed", "チャンネル参加イベントの処理に失敗", {
        channelId: input.channelId,
        via: subject.via,
        error: error instanceof Error ? error.message : "unknown",
        eventId: input.eventId,
      });
    }
  }
  return { applied, failed };
}

async function handleLeave(input: {
  subjects: Subject[];
  channelId: string;
  eventId: string;
  state: "left" | "removed";
  eventType: ChannelMembershipEventType;
}): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const subject of input.subjects) {
    try {
      const res = await upsertEmployeeChannelMembership({
        orgId: subject.orgId,
        employeeId: subject.employeeId,
        externalId: input.channelId,
        via: subject.via,
        state: input.state,
        eventId: input.eventId,
      });
      if (res.applied) applied += 1;
      await audit(subject.orgId, subject.employeeId, "channel_scope.membership_recorded", `チャンネル退出を記録（${input.state}）`, {
        channelId: input.channelId,
        via: subject.via,
        state: input.state,
        eventType: input.eventType,
        eventId: input.eventId,
      });
    } catch (error) {
      failed += 1;
      await audit(subject.orgId, subject.employeeId, "channel_scope.event_failed", "チャンネル退出イベントの処理に失敗", {
        channelId: input.channelId,
        via: subject.via,
        error: error instanceof Error ? error.message : "unknown",
        eventId: input.eventId,
      });
    }
  }
  return { applied, failed };
}

/** channel_shared: make the channel shared_external now and move excluded memberships out of scope. */
async function handleShared(input: {
  subjects: Subject[];
  channelId: string;
  eventId: string;
  connectedTeam: string | null;
}): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  const orgs = [...new Set(input.subjects.map((s) => s.orgId))];
  for (const orgId of orgs) {
    try {
      const rule = await getOrgInternalAudienceRule(orgId);
      const internal = new Set(rule.slackTeamIds.map(upper));
      const external = input.connectedTeam && !internal.has(input.connectedTeam) ? [input.connectedTeam] : [];
      const written = await upsertAutoClassifiedChannel({
        orgId,
        externalId: input.channelId,
        auto: { classification: "shared_external", mixed: true, externalTeamIds: external },
        source: "auto_join",
      });
      if (written.merged.changed || written.created) applied += 1;
      const rows = await listEmployeeChannelMemberships(orgId, { externalId: input.channelId, state: "member", limit: 500 });
      const movedOut: string[] = [];
      for (const row of rows) {
        const scope = await getEffectiveChannelScope(orgId, row.employeeId);
        const state = joinState(scope, written.channel, row.via);
        if (state === "out_of_scope") {
          await upsertEmployeeChannelMembership({
            orgId,
            employeeId: row.employeeId,
            externalId: input.channelId,
            via: row.via,
            state,
            eventId: input.eventId,
          });
          movedOut.push(row.employeeId);
        }
      }
      await audit(orgId, null, "channel_scope.channel_shared", "チャンネルが外部共有された（自動で厳格化）", {
        channelId: input.channelId,
        connectedTeamId: input.connectedTeam,
        classification: written.channel.classification,
        mixed: written.channel.mixed,
        externalTeamIds: written.channel.externalTeamIds ?? [],
        humanConfirmed: Boolean(written.channel.humanConfirmedAt),
        humanConfirmationCleared: written.confirmationCleared,
        membershipsMovedOutOfScope: movedOut,
        eventId: input.eventId,
      });
    } catch (error) {
      failed += 1;
      await audit(orgId, null, "channel_scope.event_failed", "channel_shared の処理に失敗", {
        channelId: input.channelId,
        error: error instanceof Error ? error.message : "unknown",
        eventId: input.eventId,
      });
    }
  }
  return { applied, failed };
}

export async function processChannelMembershipEnvelope(
  envelope: ChannelMembershipEnvelope,
  deps: ChannelMembershipDeps
): Promise<ChannelMembershipOutcome> {
  const event = envelope.event;
  const eventId = str(envelope.event_id);
  const eventType = str(event?.type);
  if (!event || !eventId || !isChannelMembershipEventType(eventType)) {
    return { handled: false, woke: 0, skipReason: "unsupported_event_type" };
  }
  const channelId = upper(channelIdOf(event));
  const summary = (subjects: number, applied: number, failed: number) => ({
    eventType,
    subjects,
    applied,
    failed,
  });
  if (!SLACK_CONVERSATION_ID_RE.test(channelId)) {
    // DMs / malformed ids are never part of channel scope.
    return { handled: true, woke: 0, skipReason: "channel_scope_invalid_channel", channelMembership: summary(0, 0, 0) };
  }

  const claimed = await deps.claim(eventId);
  if (!claimed) {
    return { handled: true, woke: 0, duplicate: true, skipReason: "duplicate_event" };
  }

  const auths = Array.isArray(envelope.authorizations) ? envelope.authorizations.filter(Boolean) : [];
  const fetchInfo = deps.fetchConversationInfo ?? fetchSlackConversationInfo;

  if (eventType === "member_joined_channel" || eventType === "member_left_channel") {
    const joiner = userOrNull(event.user);
    const auth = joiner ? auths.find((a) => userOrNull(a.user_id) === joiner) : undefined;
    if (!joiner || !auth) {
      // Someone else's join/leave: not ours, not stored.
      return { handled: true, woke: 0, skipReason: "channel_scope_not_self", channelMembership: summary(0, 0, 0) };
    }
    const { subjects, reason } = await resolveSubjects(auth);
    if (!subjects.length) {
      return { handled: true, woke: 0, skipReason: `channel_scope_${reason ?? "no_subject"}`, channelMembership: summary(0, 0, 0) };
    }
    const result =
      eventType === "member_joined_channel"
        ? await handleJoin({
            subjects,
            channelId,
            eventId,
            inviter: userOrNull(event.inviter),
            joinerTeam: teamOrNull(event.team),
            fetchInfo,
          })
        : await handleLeave({ subjects, channelId, eventId, state: "left", eventType });
    return { handled: true, woke: 0, channelMembership: summary(subjects.length, result.applied, result.failed) };
  }

  // channel_left / group_left / channel_shared / channel_unshared are delivered to the token
  // owner (the bot or the subscribed user) — the authorization itself is the subject.
  const auth = auths[0];
  const { subjects, reason } = auth ? await resolveSubjects(auth) : { subjects: [], reason: "authorization_invalid" };
  if (!subjects.length) {
    return { handled: true, woke: 0, skipReason: `channel_scope_${reason ?? "no_subject"}`, channelMembership: summary(0, 0, 0) };
  }

  if (eventType === "channel_left" || eventType === "group_left") {
    const actor = userOrNull(event.actor_id);
    const self = userOrNull(auth?.user_id);
    const state = actor && actor !== self ? "removed" : "left";
    const result = await handleLeave({ subjects, channelId, eventId, state, eventType });
    return { handled: true, woke: 0, channelMembership: summary(subjects.length, result.applied, result.failed) };
  }

  if (eventType === "channel_shared") {
    const result = await handleShared({ subjects, channelId, eventId, connectedTeam: teamOrNull(event.connected_team_id) });
    return { handled: true, woke: 0, channelMembership: summary(subjects.length, result.applied, result.failed) };
  }

  // channel_unshared: stricter-only — never widen automatically. Record for a human to review.
  for (const orgId of new Set(subjects.map((s) => s.orgId))) {
    await audit(orgId, null, "channel_scope.unshare_ignored", "外部共有の解除を検知（自動では社内に戻さない）", {
      channelId,
      previouslyConnectedTeamId: teamOrNull(event.previously_connected_team_id),
      eventId,
    });
  }
  return { handled: true, woke: 0, skipReason: "channel_scope_unshare_ignored", channelMembership: summary(subjects.length, 0, 0) };
}
