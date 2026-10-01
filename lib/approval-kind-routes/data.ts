/**
 * P1 Approval Kind Routes — Data Access Layer
 *
 * CRUD operations for approval kind routes policies.
 * Migration from existing routes[] (class=admin|business) to kind-based routes.
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isApprovalKindRoutesEnabled } from "@/lib/feature-flags";
import type {
  ApprovalKind,
  ApprovalKindRoute,
  EffectiveApprovalKindRoute,
  EmployeeApprovalKindRoutesOverride,
  OrgApprovalKindRoutesPolicy,
} from "./types";
import { APPROVAL_KINDS } from "./types";
import { defaultApprovalKindRoute } from "./validate";
import { DEFAULT_REMIND_EVERY_DAYS } from "./presets";
import type {
  ApprovalClassRoute,
  OrgApprovalWorkflowPolicy,
} from "@/lib/types";

const demoKindRoutesPolicies = new Map<string, OrgApprovalKindRoutesPolicy>();
const demoEmployeeOverrides = new Map<string, EmployeeApprovalKindRoutesOverride>();

/**
 * Get org-level approval kind routes policy.
 */
export async function getOrgApprovalKindRoutesPolicy(
  orgId: string
): Promise<OrgApprovalKindRoutesPolicy | null> {
  if (isDemoMode()) {
    return demoKindRoutesPolicies.get(orgId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("kind_routes_unavailable");

  const { data, error } = await admin
    .from("orgs")
    .select("approval_kind_routes_policy")
    .eq("id", orgId)
    .maybeSingle();

  if (error) throw new Error("kind_routes_policy_unavailable");
  if (!data || !data.approval_kind_routes_policy) return null;
  return data.approval_kind_routes_policy as OrgApprovalKindRoutesPolicy;
}

/**
 * Set org-level approval kind routes policy.
 */
export async function setOrgApprovalKindRoutesPolicy(
  orgId: string,
  policy: OrgApprovalKindRoutesPolicy
): Promise<boolean> {
  if (isDemoMode()) {
    demoKindRoutesPolicies.set(orgId, policy);
    return true;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("kind_routes_unavailable");

  const { data, error } = await admin
    .from("orgs")
    .update({ approval_kind_routes_policy: policy })
    .eq("id", orgId)
    .select("id")
    .maybeSingle();

  if (error) throw new Error("kind_routes_policy_write_failed");
  return Boolean(data);
}

/**
 * Get employee approval kind routes override.
 */
export async function getEmployeeApprovalKindRoutesOverride(
  employeeId: string,
  orgId: string
): Promise<EmployeeApprovalKindRoutesOverride | null> {
  if (isDemoMode()) {
    return demoEmployeeOverrides.get(`${orgId}:${employeeId}`) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("kind_routes_unavailable");

  const { data, error } = await admin
    .from("employees")
    .select("approval_kind_routes_override")
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) throw new Error("kind_routes_override_unavailable");
  if (!data || !data.approval_kind_routes_override) return null;
  return data.approval_kind_routes_override as EmployeeApprovalKindRoutesOverride;
}

/**
 * Set employee approval kind routes override.
 */
export async function setEmployeeApprovalKindRoutesOverride(
  employeeId: string,
  orgId: string,
  override: EmployeeApprovalKindRoutesOverride | null
): Promise<boolean> {
  if (isDemoMode()) {
    const key = `${orgId}:${employeeId}`;
    if (override) {
      demoEmployeeOverrides.set(key, override);
    } else {
      demoEmployeeOverrides.delete(key);
    }
    return true;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("kind_routes_unavailable");

  const { data, error } = await admin
    .from("employees")
    .update({ approval_kind_routes_override: override })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("id")
    .maybeSingle();

  if (error) throw new Error("kind_routes_override_write_failed");
  return Boolean(data);
}

/**
 * Map existing routes[] class to approval kinds.
 *
 * Migration logic:
 * - admin class → account kind
 * - business class → post, mail, other kinds
 */
function mapClassRouteToKinds(
  classRoute: ApprovalClassRoute
): ApprovalKind[] {
  switch (classRoute.class) {
    case "admin":
      return ["account"];
    case "business":
      return ["post", "mail", "other"];
    default:
      return [];
  }
}

/**
 * Convert existing ApprovalClassRoute to ApprovalKindRoute.
 */
function convertClassRouteToKindRoute(
  classRoute: ApprovalClassRoute,
  kind: ApprovalKind
): ApprovalKindRoute {
  const stage = classRoute.stages[0];
  if (!stage) {
    throw new Error("empty_stages_in_class_route");
  }

  let quorum: ApprovalKindRoute["quorum"];
  switch (stage.quorum.type) {
    case "any":
      quorum = { type: "any" };
      break;
    case "count":
      quorum = { type: "count", n: stage.quorum.n };
      break;
    case "majority":
    case "ratio":
      quorum = { type: "all" };
      break;
    default:
      quorum = { type: "any" };
  }

  return {
    kind,
    approverUserIds: stage.voterUserIds,
    quorum,
    finalGoUserId: classRoute.finalGoUserId ?? null,
    deadlineHours: null,
    onExpire: stage.onReject === "fail_closed" ? "fail_closed" : "keep_open",
    remindEveryDays: DEFAULT_REMIND_EVERY_DAYS,
    notifyChannelIds: [],
  };
}

/**
 * Migrate existing routes[] (class=admin|business) to kind-based routes.
 *
 * This ensures behavior is unchanged when flag is first enabled.
 * If no routes[] exist, returns null (use default owner 1名).
 */
export function migrateClassRoutesToKindRoutes(
  existingPolicy: OrgApprovalWorkflowPolicy | null,
  ownerUserId: string
): OrgApprovalKindRoutesPolicy | null {
  if (!existingPolicy || !existingPolicy.routes || existingPolicy.routes.length === 0) {
    return null;
  }

  const kindRoutes: ApprovalKindRoute[] = [];
  const coveredKinds = new Set<ApprovalKind>();

  for (const classRoute of existingPolicy.routes) {
    const kinds = mapClassRouteToKinds(classRoute);
    for (const kind of kinds) {
      if (!coveredKinds.has(kind)) {
        kindRoutes.push(convertClassRouteToKindRoute(classRoute, kind));
        coveredKinds.add(kind);
      }
    }
  }

  // Fill in uncovered kinds with default (owner 1名)
  for (const kind of APPROVAL_KINDS) {
    if (!coveredKinds.has(kind)) {
      kindRoutes.push(defaultApprovalKindRoute(kind, ownerUserId));
    }
  }

  return {
    version: 1,
    policyId: `akr_migrated_${Date.now().toString(36)}`,
    policyName: "移行済み承認ルート",
    routes: kindRoutes,
    updatedAt: new Date().toISOString(),
    updatedBy: "migration",
  };
}

/**
 * Get the existing approval workflow policy (for migration).
 * This reads from the same source as approval-workflow/data.ts
 */
async function getExistingWorkflowPolicy(
  orgId: string
): Promise<OrgApprovalWorkflowPolicy | null> {
  if (isDemoMode()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("orgs")
    .select("approval_workflow_policy")
    .eq("id", orgId)
    .maybeSingle();

  if (error || !data || !data.approval_workflow_policy) return null;
  return data.approval_workflow_policy as OrgApprovalWorkflowPolicy;
}

/**
 * Get effective approval route for a specific kind.
 *
 * Resolution order:
 * 1. Employee override (if present and P1_APPROVAL_KIND_ROUTES_ENABLED)
 * 2. Org kind routes policy (if present and P1_APPROVAL_KIND_ROUTES_ENABLED)
 * 3. Legacy routes[] migration (if P1_APPROVAL_KIND_ROUTES_ENABLED and existing routes[])
 * 4. Default (owner 1名)
 *
 * When P1_APPROVAL_KIND_ROUTES_ENABLED is OFF, always returns default (legacy behavior).
 */
export async function getEffectiveApprovalKindRoute(
  orgId: string,
  kind: ApprovalKind,
  employeeId?: string | null,
  ownerUserId?: string
): Promise<EffectiveApprovalKindRoute> {
  const defaultOwner = ownerUserId || "";
  const defaultRoute = defaultApprovalKindRoute(kind, defaultOwner);

  // When flag is OFF, return default (legacy behavior)
  if (!isApprovalKindRoutesEnabled()) {
    return {
      route: defaultRoute,
      source: "default",
      orgRoute: null,
      employeeOverride: null,
    };
  }

  // Check employee override first
  if (employeeId) {
    const override = await getEmployeeApprovalKindRoutesOverride(employeeId, orgId);
    if (override && override.routes[kind]) {
      const mergedRoute = {
        ...defaultRoute,
        ...override.routes[kind],
        kind,
      } as ApprovalKindRoute;
      return {
        route: mergedRoute,
        source: "employee",
        orgRoute: null,
        employeeOverride: override.routes[kind],
      };
    }
  }

  // Check org kind routes policy (new P1 policy)
  const orgPolicy = await getOrgApprovalKindRoutesPolicy(orgId);
  if (orgPolicy) {
    const orgRoute = orgPolicy.routes.find((r) => r.kind === kind);
    if (orgRoute) {
      return {
        route: orgRoute,
        source: "org",
        orgRoute,
        employeeOverride: null,
      };
    }
  }

  // Migrate from existing routes[] (class=admin|business) if present
  const existingWorkflowPolicy = await getExistingWorkflowPolicy(orgId);
  if (existingWorkflowPolicy?.routes && existingWorkflowPolicy.routes.length > 0) {
    const migratedPolicy = migrateClassRoutesToKindRoutes(existingWorkflowPolicy, defaultOwner);
    if (migratedPolicy) {
      const migratedRoute = migratedPolicy.routes.find((r) => r.kind === kind);
      if (migratedRoute) {
        return {
          route: migratedRoute,
          source: "org",
          orgRoute: migratedRoute,
          employeeOverride: null,
        };
      }
    }
  }

  // Return default (owner 1名)
  return {
    route: defaultRoute,
    source: "default",
    orgRoute: null,
    employeeOverride: null,
  };
}

/**
 * Get all effective approval kind routes for an org.
 */
export async function getAllEffectiveApprovalKindRoutes(
  orgId: string,
  employeeId?: string | null,
  ownerUserId?: string
): Promise<Record<ApprovalKind, EffectiveApprovalKindRoute>> {
  const result = {} as Record<ApprovalKind, EffectiveApprovalKindRoute>;

  for (const kind of APPROVAL_KINDS) {
    result[kind] = await getEffectiveApprovalKindRoute(orgId, kind, employeeId, ownerUserId);
  }

  return result;
}

/**
 * Reset demo data (for testing).
 */
export function resetDemoApprovalKindRoutesData(): void {
  demoKindRoutesPolicies.clear();
  demoEmployeeOverrides.clear();
}
