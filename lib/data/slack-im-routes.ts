import { getOrgChannel } from "@/lib/data/directory";
import { getEmployee } from "@/lib/data/employees";
import {
  getSlackWakeTargetByEmployeeId,
  type SlackMentionTarget,
} from "@/lib/data/slack-identities";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { ChannelClassification, ConversationSurface } from "@/lib/types";

export type SlackImRouteSource = "manual" | "auto_party";

export type SlackImEmployeeRoute = {
  orgId: string;
  slackChannelId: string;
  slackTeamId: string;
  employeeId: string;
  /**
   * How the route was installed. "manual" = channels.classify (human approval);
   * "auto_party" = SLACK_DM_AUTOROUTE_ENABLED derived from an internal org_parties
   * slack_user. Columns exist only after migration 20261004000000; rows read
   * without them are "manual".
   */
  source?: SlackImRouteSource;
  counterpartSlackUserId?: string | null;
  createdAt: string;
  updatedAt: string;
};

const demoRoutes = new Map<string, SlackImEmployeeRoute>();

function nowIso(): string {
  return new Date().toISOString();
}

function routeKey(orgId: string, slackChannelId: string): string {
  return `${orgId.trim()}:${slackChannelId.trim().toUpperCase()}`;
}

function mapRow(row: Record<string, unknown>): SlackImEmployeeRoute {
  return {
    orgId: String(row.org_id ?? ""),
    slackChannelId: String(row.slack_channel_id ?? ""),
    slackTeamId: String(row.slack_team_id ?? ""),
    employeeId: String(row.employee_id ?? ""),
    source: row.source === "auto_party" ? "auto_party" : "manual",
    counterpartSlackUserId:
      typeof row.counterpart_slack_user_id === "string" && row.counterpart_slack_user_id
        ? row.counterpart_slack_user_id
        : null,
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

const ROUTE_COLUMNS = "org_id,slack_channel_id,slack_team_id,employee_id,created_at,updated_at";
const ROUTE_COLUMNS_WITH_SOURCE =
  "org_id,slack_channel_id,slack_team_id,employee_id,created_at,updated_at,source,counterpart_slack_user_id";

export function isSlackImChannelId(value: string): boolean {
  return /^D[A-Z0-9]+$/i.test(value.trim());
}

export async function deleteSlackImEmployeeRoute(input: {
  orgId: string;
  slackChannelId: string;
}): Promise<void> {
  const orgId = input.orgId.trim();
  const slackChannelId = input.slackChannelId.trim();
  if (!orgId || !slackChannelId) return;
  if (isDemoMode()) {
    demoRoutes.delete(routeKey(orgId, slackChannelId));
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { error } = await admin
    .from("slack_im_employee_routes")
    .delete()
    .eq("org_id", orgId)
    .eq("slack_channel_id", slackChannelId);
  if (error) throw new Error(error.message || "slack_im_route_delete_failed");
}

export async function upsertSlackImEmployeeRoute(input: {
  orgId: string;
  slackChannelId: string;
  slackTeamId?: string | null;
  employeeId: string;
  /**
   * Only written when provided (callers pass it only while
   * SLACK_DM_AUTOROUTE_ENABLED is ON, i.e. after the migration). Omitted →
   * the source/counterpart columns are not touched (pre-migration safe).
   */
  source?: SlackImRouteSource;
  counterpartSlackUserId?: string | null;
}): Promise<SlackImEmployeeRoute> {
  const orgId = input.orgId.trim();
  const slackChannelId = input.slackChannelId.trim();
  const slackTeamId = (input.slackTeamId || "").trim();
  const employeeId = input.employeeId.trim();
  if (!orgId || !isSlackImChannelId(slackChannelId) || !employeeId) {
    throw new Error("invalid_slack_im_route");
  }
  const employee = await getEmployee(employeeId, orgId);
  if (!employee) throw new Error("employee_not_found");
  if (employee.status !== "active") throw new Error("employee_not_active");
  const timestamp = nowIso();
  if (isDemoMode()) {
    const key = routeKey(orgId, slackChannelId);
    const existing = demoRoutes.get(key);
    const source = input.source ?? existing?.source ?? "manual";
    const route: SlackImEmployeeRoute = {
      orgId,
      slackChannelId,
      slackTeamId,
      employeeId,
      source,
      counterpartSlackUserId:
        input.source !== undefined
          ? source === "auto_party"
            ? (input.counterpartSlackUserId || "").trim() || null
            : null
          : existing?.counterpartSlackUserId ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    demoRoutes.set(key, route);
    return route;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const withSource = input.source !== undefined;
  const row: Record<string, unknown> = {
    org_id: orgId,
    slack_channel_id: slackChannelId,
    slack_team_id: slackTeamId,
    employee_id: employeeId,
    updated_at: timestamp,
  };
  if (withSource) {
    row.source = input.source;
    row.counterpart_slack_user_id =
      input.source === "auto_party" ? (input.counterpartSlackUserId || "").trim() || null : null;
  }
  const { data, error } = await admin
    .from("slack_im_employee_routes")
    .upsert(row, { onConflict: "org_id,slack_channel_id" })
    .select(withSource ? ROUTE_COLUMNS_WITH_SOURCE : ROUTE_COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message || "slack_im_route_upsert_failed");
  return mapRow(data as unknown as Record<string, unknown>);
}

/**
 * Keep the ingress route aligned with channels.classify. Missing employee,
 * non-IM, mixed, or non-internal input always removes the route (fail-closed).
 */
export async function syncSlackImEmployeeRoute(input: {
  orgId: string;
  surface: ConversationSurface;
  slackChannelId: string;
  slackTeamId?: string | null;
  classification: ChannelClassification;
  mixed: boolean;
  employeeId?: string | null;
  source?: SlackImRouteSource;
  counterpartSlackUserId?: string | null;
}): Promise<SlackImEmployeeRoute | null> {
  const employeeId = (input.employeeId || "").trim();
  const enabled =
    input.surface === "slack" &&
    isSlackImChannelId(input.slackChannelId) &&
    input.classification === "internal" &&
    !input.mixed &&
    Boolean(employeeId);
  if (!enabled) {
    await deleteSlackImEmployeeRoute({
      orgId: input.orgId,
      slackChannelId: input.slackChannelId,
    });
    return null;
  }
  return upsertSlackImEmployeeRoute({
    orgId: input.orgId,
    slackChannelId: input.slackChannelId,
    slackTeamId: input.slackTeamId,
    employeeId,
    ...(input.source !== undefined
      ? { source: input.source, counterpartSlackUserId: input.counterpartSlackUserId ?? null }
      : {}),
  });
}

async function listCandidateRoutes(input: {
  slackChannelId: string;
  slackTeamId: string;
}): Promise<SlackImEmployeeRoute[]> {
  const channel = input.slackChannelId.trim();
  const team = input.slackTeamId.trim().toUpperCase();
  const teamMatches = (route: SlackImEmployeeRoute) => {
    const stored = route.slackTeamId.trim().toUpperCase();
    return stored ? Boolean(team) && stored === team : true;
  };
  if (isDemoMode()) {
    return [...demoRoutes.values()].filter(
      (route) =>
        route.slackChannelId.toUpperCase() === channel.toUpperCase() &&
        teamMatches(route)
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const variants = [...new Set([channel, channel.toUpperCase(), channel.toLowerCase()])];
  const { data, error } = await admin
    .from("slack_im_employee_routes")
    .select("org_id,slack_channel_id,slack_team_id,employee_id,created_at,updated_at")
    .in("slack_channel_id", variants);
  if (error || !data) return [];
  return data
    .map((row) => mapRow(row as Record<string, unknown>))
    .filter(teamMatches);
}

/** Cross-org candidates for one DM (same rule the wake resolver uses). Metadata only. */
export async function listSlackImRoutesForChannel(input: {
  slackChannelId: string;
  slackTeamId: string;
}): Promise<SlackImEmployeeRoute[]> {
  if (!isSlackImChannelId(input.slackChannelId)) return [];
  return listCandidateRoutes(input);
}

/** One org-scoped route by DM id (base columns only; pre-migration safe). */
export async function getSlackImEmployeeRoute(
  orgId: string,
  slackChannelId: string
): Promise<SlackImEmployeeRoute | null> {
  const org = orgId.trim();
  const channel = slackChannelId.trim();
  if (!org || !channel) return null;
  if (isDemoMode()) return demoRoutes.get(routeKey(org, channel)) ?? null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("slack_im_employee_routes")
    .select(ROUTE_COLUMNS)
    .eq("org_id", org)
    .eq("slack_channel_id", channel)
    .maybeSingle();
  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}

/**
 * Auto-installed (source=auto_party) routes in one org, optionally narrowed to
 * a counterpart or an employee. Reads the migration-added columns, so callers
 * must only use it while SLACK_DM_AUTOROUTE_ENABLED is ON.
 */
export async function listAutoSlackImRoutes(input: {
  orgId: string;
  counterpartSlackUserId?: string;
  employeeId?: string;
}): Promise<SlackImEmployeeRoute[]> {
  const orgId = input.orgId.trim();
  if (!orgId) return [];
  const counterpart = (input.counterpartSlackUserId || "").trim();
  const employeeId = (input.employeeId || "").trim();
  if (isDemoMode()) {
    return [...demoRoutes.values()].filter(
      (route) =>
        route.orgId === orgId &&
        route.source === "auto_party" &&
        (!counterpart || route.counterpartSlackUserId === counterpart) &&
        (!employeeId || route.employeeId === employeeId)
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  let query = admin
    .from("slack_im_employee_routes")
    .select(ROUTE_COLUMNS_WITH_SOURCE)
    .eq("org_id", orgId)
    .eq("source", "auto_party");
  if (counterpart) query = query.eq("counterpart_slack_user_id", counterpart);
  if (employeeId) query = query.eq("employee_id", employeeId);
  const { data, error } = await query;
  if (error) throw new Error(error.message || "slack_im_route_list_failed");
  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function countSlackImRoutesByOrg(orgId: string): Promise<number> {
  if (!orgId) return 0;
  if (isDemoMode()) {
    return [...demoRoutes.values()].filter((route) => route.orgId === orgId).length;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return 0;
  const { count, error } = await admin
    .from("slack_im_employee_routes")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId);
  if (error || count === null) return 0;
  return count;
}

export async function listSlackImRoutesByOrg(orgId: string): Promise<SlackImEmployeeRoute[]> {
  if (!orgId) return [];
  if (isDemoMode()) {
    return [...demoRoutes.values()].filter((route) => route.orgId === orgId);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("slack_im_employee_routes")
    .select("org_id,slack_channel_id,slack_team_id,employee_id,created_at,updated_at")
    .eq("org_id", orgId);
  if (error || !data) return [];
  return data.map((row) => mapRow(row as Record<string, unknown>));
}

/** Resolve only one classified internal Staffpass-app DM; ambiguity denies. */
export async function resolveSlackImWakeTarget(input: {
  slackChannelId: string;
  slackTeamId: string;
}): Promise<SlackMentionTarget | null> {
  if (!isSlackImChannelId(input.slackChannelId)) return null;
  const routes = await listCandidateRoutes(input);
  if (routes.length !== 1) return null;
  const route = routes[0];
  const channel = await getOrgChannel(route.orgId, "slack", route.slackChannelId);
  if (!channel || channel.classification !== "internal" || channel.mixed) return null;
  return getSlackWakeTargetByEmployeeId({
    employeeId: route.employeeId,
    orgId: route.orgId,
  });
}

/**
 * Resolve user-token message.im wake target for human↔human DM (SLICE B).
 *
 * User-token events arrive when:
 * 1. Employee linked Slack identity with im:history scope
 * 2. Slack app configured "Subscribe to events on behalf of users" for message.im
 * 3. Someone posts in a human↔human DM where the employee is a participant
 *
 * Fail-closed rules:
 * - authorizedSlackUserId must match exactly one linked employee
 * - slackChannelId must have exactly one route in slack_im_employee_routes
 * - route employee must match the authorized employee
 * - channel must be classified internal, not mixed
 *
 * Privacy: If any condition fails, silently ignore (no wake, no storage).
 */
export async function resolveSlackUserTokenImWakeTarget(input: {
  slackChannelId: string;
  slackTeamId: string;
  authorizedSlackUserId: string;
}): Promise<SlackMentionTarget | null> {
  const authorizedUserId = input.authorizedSlackUserId.trim().toUpperCase();
  if (!authorizedUserId || !isSlackImChannelId(input.slackChannelId)) return null;

  const routes = await listCandidateRoutes(input);
  if (routes.length !== 1) return null;
  const route = routes[0];

  const channel = await getOrgChannel(route.orgId, "slack", route.slackChannelId);
  if (!channel || channel.classification !== "internal" || channel.mixed) return null;

  const target = await getSlackWakeTargetByEmployeeId({
    employeeId: route.employeeId,
    orgId: route.orgId,
  });
  if (!target) return null;

  if (target.slackUserId.toUpperCase() !== authorizedUserId) return null;

  return target;
}
