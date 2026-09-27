/**
 * Admin-class approval policy enforcement.
 *
 * When ADMIN_APPROVER_POLICY_REQUIRED flag is enabled:
 * - Admin-class tickets require an org-level policy with a matching admin-class route,
 *   OR fall back to org owners as default admin approvers.
 * - Employee overrides cannot satisfy or replace the admin route requirement.
 * - Business-route voters cannot vote on admin-class tickets.
 * - If no admin route and no org owners exist, fail closed.
 *
 * Default admin-class approver = org owner(s). An org can set a specific member
 * instead via policy routes configuration.
 *
 * When flag is OFF: existing W1 behavior (any single approver) is preserved.
 */

import { isAdminApproverPolicyRequired } from "@/lib/feature-flags";
import {
  ADMIN_AUDIT_CLASS,
  BUSINESS_AUDIT_CLASS,
  getApprovalRouteClass,
  isAdminClassApproval,
  type ApprovalRouteClass,
} from "@/lib/admin-mcp/audit-class";
import type {
  ApprovalClassRoute,
  ApprovalLane,
  ApprovalRequest,
  OrgApprovalWorkflowPolicy,
} from "@/lib/types";

export type AdminPolicyCheckResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

/**
 * Find the route for a given approval class in the policy.
 */
export function findRouteForClass(
  policy: OrgApprovalWorkflowPolicy | null,
  approvalClass: ApprovalRouteClass
): ApprovalClassRoute | null {
  if (!policy?.routes || !Array.isArray(policy.routes)) return null;
  return policy.routes.find((r) => r.class === approvalClass) ?? null;
}

/**
 * Check if an org-level policy has a valid admin route.
 * Admin route must have at least one stage with voters.
 */
export function hasValidAdminRoute(
  policy: OrgApprovalWorkflowPolicy | null
): boolean {
  const adminRoute = findRouteForClass(policy, ADMIN_AUDIT_CLASS);
  if (!adminRoute) return false;
  if (!adminRoute.stages || adminRoute.stages.length === 0) return false;
  return adminRoute.stages.some(
    (stage) => stage.voterUserIds && stage.voterUserIds.length > 0
  );
}

/**
 * Build a default admin route from org owners.
 * Used when no explicit admin route is configured but org owners exist.
 * The route uses single-stage with "any" quorum (any org owner can approve).
 */
export function buildDefaultAdminRouteFromOwners(
  ownerIds: string[]
): ApprovalClassRoute | null {
  if (!ownerIds || ownerIds.length === 0) return null;
  const stage: ApprovalLane = {
    id: "default_admin_stage",
    nameJa: "組織オーナー承認",
    voterUserIds: ownerIds,
    quorum: { type: "any" },
    onReject: "fail_closed",
  };
  return {
    class: ADMIN_AUDIT_CLASS,
    stages: [stage],
  };
}

/**
 * Check if admin approval can proceed with org owners as fallback.
 * Returns true if either:
 * 1. Policy has explicit admin route with voters, OR
 * 2. Org owners are available as default admin approvers
 */
export function canProceedWithAdminApproval(
  policy: OrgApprovalWorkflowPolicy | null,
  orgOwnerIds: string[]
): boolean {
  if (hasValidAdminRoute(policy)) return true;
  return orgOwnerIds.length > 0;
}

/**
 * Get the effective admin route, using org owners as fallback.
 * Priority:
 * 1. Explicit admin route from policy
 * 2. Default route built from org owners
 */
export function getEffectiveAdminRoute(
  policy: OrgApprovalWorkflowPolicy | null,
  orgOwnerIds: string[]
): ApprovalClassRoute | null {
  const explicitRoute = findRouteForClass(policy, ADMIN_AUDIT_CLASS);
  if (explicitRoute && explicitRoute.stages?.some((s) => s.voterUserIds?.length > 0)) {
    return explicitRoute;
  }
  return buildDefaultAdminRouteFromOwners(orgOwnerIds);
}

/**
 * Check if an approval can proceed under the admin policy requirement.
 *
 * When ADMIN_APPROVER_POLICY_REQUIRED is ON:
 * - Admin-class approvals require either:
 *   a) An org-level policy with explicit admin route, OR
 *   b) Org owners available as default admin approvers
 * - Employee overrides cannot satisfy the admin route requirement
 * - If neither explicit route nor org owners exist, fail closed
 *
 * When OFF: always returns ok (existing W1 behavior preserved).
 *
 * @param approval - The approval request to check
 * @param orgPolicy - Org-level approval workflow policy (may be null)
 * @param employeePolicy - Employee-level policy override (ignored for admin class)
 * @param orgOwnerIds - Org owner member IDs for fallback (empty array = no fallback)
 */
export function checkAdminPolicyRequirement(
  approval: Pick<ApprovalRequest, "purpose" | "tool" | "metadata">,
  orgPolicy: OrgApprovalWorkflowPolicy | null,
  employeePolicy: OrgApprovalWorkflowPolicy | null,
  orgOwnerIds: string[] = []
): AdminPolicyCheckResult {
  if (!isAdminApproverPolicyRequired()) {
    return { ok: true };
  }

  if (!isAdminClassApproval(approval)) {
    return { ok: true };
  }

  if (hasValidAdminRoute(orgPolicy)) {
    return { ok: true };
  }

  if (orgOwnerIds.length > 0) {
    return { ok: true };
  }

  if (employeePolicy && !orgPolicy) {
    return {
      ok: false,
      code: "admin_policy_required",
      reason:
        "admin_class_requires_org_policy: employee override cannot satisfy admin route requirement",
    };
  }

  return {
    ok: false,
    code: "admin_policy_required",
    reason:
      "admin_class_requires_admin_approver: no admin route configured and no org owners available",
  };
}

/**
 * Get the effective policy for an approval, considering class-based routing.
 *
 * For admin-class approvals when flag is ON:
 * - Must use org-level policy with admin route, OR org owners as fallback
 * - Employee override is ignored for admin-class routing
 *
 * For business-class approvals:
 * - Employee override takes precedence (existing coalesce behavior)
 *
 * @param approval - The approval request
 * @param orgPolicy - Org-level approval workflow policy
 * @param employeePolicy - Employee-level policy override
 * @param orgOwnerIds - Org owner member IDs for admin class fallback
 */
export function getEffectiveClassPolicy(
  approval: Pick<ApprovalRequest, "purpose" | "tool" | "metadata">,
  orgPolicy: OrgApprovalWorkflowPolicy | null,
  employeePolicy: OrgApprovalWorkflowPolicy | null,
  orgOwnerIds: string[] = []
): {
  policy: OrgApprovalWorkflowPolicy | null;
  source: "org" | "employee" | "org_owners_default" | "none";
  route: ApprovalClassRoute | null;
  approvalClass: ApprovalRouteClass;
} {
  const approvalClass = getApprovalRouteClass(approval);

  if (isAdminApproverPolicyRequired() && approvalClass === ADMIN_AUDIT_CLASS) {
    const effectiveRoute = getEffectiveAdminRoute(orgPolicy, orgOwnerIds);
    const source = hasValidAdminRoute(orgPolicy)
      ? "org"
      : orgOwnerIds.length > 0
        ? "org_owners_default"
        : "none";
    return {
      policy: orgPolicy,
      source,
      route: effectiveRoute,
      approvalClass,
    };
  }

  const effectivePolicy = employeePolicy ?? orgPolicy;
  const route = findRouteForClass(effectivePolicy, approvalClass);
  return {
    policy: effectivePolicy,
    source: employeePolicy ? "employee" : orgPolicy ? "org" : "none",
    route,
    approvalClass,
  };
}

/**
 * Check if a voter can vote on an approval based on class membership.
 *
 * When ADMIN_APPROVER_POLICY_REQUIRED is ON:
 * - Business voters (from business route) cannot vote on admin-class tickets
 * - Admin voters (from admin route) can vote on admin-class tickets
 *
 * When OFF: existing behavior (any configured voter can vote).
 */
export function canVoterVoteOnApproval(
  voterUserId: string,
  approval: { purpose?: string | null; tool?: string | null; metadata?: Record<string, unknown> | null },
  policy: OrgApprovalWorkflowPolicy | null
): { allowed: boolean; reason: string } {
  if (!isAdminApproverPolicyRequired()) {
    return { allowed: true, reason: "flag_off" };
  }

  if (!isAdminClassApproval(approval)) {
    return { allowed: true, reason: "business_class" };
  }

  if (!policy?.routes || policy.routes.length === 0) {
    return { allowed: true, reason: "no_class_routes" };
  }

  const adminRoute = findRouteForClass(policy, ADMIN_AUDIT_CLASS);
  const businessRoute = findRouteForClass(policy, BUSINESS_AUDIT_CLASS);

  if (adminRoute) {
    const isInAdminRoute = adminRoute.stages.some((stage) =>
      stage.voterUserIds.includes(voterUserId)
    );
    if (isInAdminRoute) {
      return { allowed: true, reason: "in_admin_route" };
    }
  }

  if (businessRoute) {
    const isInBusinessRoute = businessRoute.stages.some((stage) =>
      stage.voterUserIds.includes(voterUserId)
    );
    if (isInBusinessRoute) {
      return {
        allowed: false,
        reason: "business_voter_on_admin_ticket",
      };
    }
  }

  if (!adminRoute) {
    return {
      allowed: true,
      reason: "no_admin_route_check_fallback_stages",
    };
  }

  return {
    allowed: false,
    reason: "not_in_admin_route",
  };
}

/**
 * Check if a resolver can resolve an admin-class approval (W1 path).
 *
 * When enforcement is ON and no explicit admin route exists:
 * - Only org owners can resolve admin-class tickets
 * - Non-owner members are rejected
 *
 * When enforcement is OFF: existing W1 behavior (any approver can resolve).
 *
 * @param resolverId - The member ID attempting to resolve
 * @param approval - The approval being resolved
 * @param policy - Org-level approval workflow policy
 * @param orgOwnerIds - List of org owner member IDs
 * @param enforcementEnabled - Whether admin_approver_enforcement is ON for this org
 */
export function canResolverResolveAdminApproval(
  resolverId: string,
  approval: { purpose?: string | null; tool?: string | null; metadata?: Record<string, unknown> | null },
  policy: OrgApprovalWorkflowPolicy | null,
  orgOwnerIds: string[],
  enforcementEnabled: boolean
): { allowed: boolean; reason: string } {
  if (!enforcementEnabled) {
    return { allowed: true, reason: "enforcement_off" };
  }

  if (!isAdminClassApproval(approval)) {
    return { allowed: true, reason: "business_class" };
  }

  if (hasValidAdminRoute(policy)) {
    const isInAdminRoute = findRouteForClass(policy, ADMIN_AUDIT_CLASS)?.stages.some(
      (stage) => stage.voterUserIds.includes(resolverId)
    );
    if (isInAdminRoute) {
      return { allowed: true, reason: "in_admin_route" };
    }
    const isInBusinessRoute = findRouteForClass(policy, BUSINESS_AUDIT_CLASS)?.stages.some(
      (stage) => stage.voterUserIds.includes(resolverId)
    );
    if (isInBusinessRoute) {
      return { allowed: false, reason: "business_voter_on_admin_ticket" };
    }
    return { allowed: false, reason: "not_in_admin_route" };
  }

  if (orgOwnerIds.includes(resolverId)) {
    return { allowed: true, reason: "org_owner_default" };
  }

  return { allowed: false, reason: "non_owner_on_admin_ticket" };
}

export { ADMIN_AUDIT_CLASS, BUSINESS_AUDIT_CLASS };
