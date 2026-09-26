/**
 * Admin-class approval policy enforcement.
 *
 * When ADMIN_APPROVER_POLICY_REQUIRED flag is enabled:
 * - Admin-class tickets require an org-level policy with a matching admin-class route.
 * - Employee overrides cannot satisfy or replace the admin route requirement.
 * - Business-route voters cannot vote on admin-class tickets.
 * - If policy is absent, fail closed (reason code "admin_policy_required").
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
 * Check if an approval can proceed under the admin policy requirement.
 *
 * When ADMIN_APPROVER_POLICY_REQUIRED is ON:
 * - Admin-class approvals require an org-level policy with admin route
 * - Employee overrides cannot satisfy the admin route requirement
 *
 * When OFF: always returns ok (existing W1 behavior preserved).
 */
export function checkAdminPolicyRequirement(
  approval: Pick<ApprovalRequest, "purpose" | "tool" | "metadata">,
  orgPolicy: OrgApprovalWorkflowPolicy | null,
  employeePolicy: OrgApprovalWorkflowPolicy | null
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
      "admin_class_requires_org_policy: org-level admin route policy is required for admin-class approvals",
  };
}

/**
 * Get the effective policy for an approval, considering class-based routing.
 *
 * For admin-class approvals when flag is ON:
 * - Must use org-level policy with admin route
 * - Employee override is ignored for admin-class routing
 *
 * For business-class approvals:
 * - Employee override takes precedence (existing coalesce behavior)
 */
export function getEffectiveClassPolicy(
  approval: Pick<ApprovalRequest, "purpose" | "tool" | "metadata">,
  orgPolicy: OrgApprovalWorkflowPolicy | null,
  employeePolicy: OrgApprovalWorkflowPolicy | null
): {
  policy: OrgApprovalWorkflowPolicy | null;
  source: "org" | "employee" | "none";
  route: ApprovalClassRoute | null;
  approvalClass: ApprovalRouteClass;
} {
  const approvalClass = getApprovalRouteClass(approval);

  if (isAdminApproverPolicyRequired() && approvalClass === ADMIN_AUDIT_CLASS) {
    const adminRoute = findRouteForClass(orgPolicy, ADMIN_AUDIT_CLASS);
    return {
      policy: orgPolicy,
      source: orgPolicy ? "org" : "none",
      route: adminRoute,
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
  approval: Pick<ApprovalRequest, "purpose" | "tool" | "metadata">,
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

export { ADMIN_AUDIT_CLASS, BUSINESS_AUDIT_CLASS };
