import { getOrgChannel } from "@/lib/data/directory";
import { getEmployee } from "@/lib/data/employees";
import {
  getSlackWakeTargetByEmployeeId,
  type SlackMentionTarget,
} from "@/lib/data/slack-identities";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { ChannelClassification, ConversationSurface } from "@/lib/types";

export type SlackImEmployeeRoute = {
  orgId: string;
  slackChannelId: string;
  slackTeamId: string;
  employeeId: string;
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
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

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
    const route: SlackImEmployeeRoute = {
      orgId,
      slackChannelId,
      slackTeamId,
      employeeId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    demoRoutes.set(key, route);
    return route;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("slack_im_employee_routes")
    .upsert(
      {
        org_id: orgId,
        slack_channel_id: slackChannelId,
        slack_team_id: slackTeamId,
        employee_id: employeeId,
        updated_at: timestamp,
      },
      { onConflict: "org_id,slack_channel_id" }
    )
    .select("org_id,slack_channel_id,slack_team_id,employee_id,created_at,updated_at")
    .single();
  if (error || !data) throw new Error(error?.message || "slack_im_route_upsert_failed");
  return mapRow(data as Record<string, unknown>);
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
