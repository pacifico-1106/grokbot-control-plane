/**
 * P1 Approval Kind Routes — Workflow Bridge
 *
 * Bridges kind-based routing into the existing approval workflow system.
 * When P1_APPROVAL_KIND_ROUTES_ENABLED is ON, this module:
 * - Determines approvers from kind routes instead of class routes
 * - Creates synthetic workflow policies for the existing ballot system
 * - Integrates with expiry/onExpire and reminder handling
 *
 * When the flag is OFF, all functions return null to preserve existing behavior.
 */

import { isApprovalKindRoutesEnabled } from "@/lib/feature-flags";
import { getEffectiveApprovalKindRoute } from "./data";
import { getToolApprovalKind } from "./tool-kind-map";
import type { ApprovalKind, ApprovalKindRoute, ApprovalKindQuorum, OnExpireBehavior } from "./types";
import type {
  ApprovalLane,
  ApprovalRequest,
  OrgApprovalWorkflowPolicy,
  QuorumRule,
} from "@/lib/types";

/**
 * Convert ApprovalKindQuorum to QuorumRule for the workflow system.
 * "all" is converted to "majority" with count equal to total voters.
 */
function convertKindQuorumToWorkflowQuorum(
  kindQuorum: ApprovalKindQuorum,
  voterCount: number
): QuorumRule {
  switch (kindQuorum.type) {
    case "any":
      return { type: "any" };
    case "count":
      return { type: "count", n: kindQuorum.n };
    case "all":
      // "all" means everyone must approve - use count equal to total voters
      return { type: "count", n: voterCount };
    default:
      return { type: "any" };
  }
}

/**
 * Extended metadata for kind-routed approvals.
 * Stored in approval.metadata.kindRouting
 */
export interface KindRoutingMetadata {
  kind: ApprovalKind;
  policyId: string;
  routeSnapshot: ApprovalKindRoute;
  deadlineAt?: string | null;
  lastReminderAt?: string | null;
  reminderCount?: number;
}

/**
 * Get approvers for an approval based on kind routing.
 * Returns null when flag is OFF (use existing class-based routing).
 */
export async function getKindRouteApprovers(
  orgId: string,
  tool: string | null | undefined,
  employeeId?: string | null,
  ownerUserId?: string
): Promise<{
  approverUserIds: string[];
  route: ApprovalKindRoute;
  kind: ApprovalKind;
} | null> {
  if (!isApprovalKindRoutesEnabled()) {
    return null;
  }

  const kind = getToolApprovalKind(tool);
  const effective = await getEffectiveApprovalKindRoute(orgId, kind, employeeId, ownerUserId);

  return {
    approverUserIds: effective.route.approverUserIds,
    route: effective.route,
    kind,
  };
}

/**
 * Build a synthetic workflow policy from a kind route.
 * This allows the existing workflow system to handle ballots, voting, and expiry.
 */
export function buildSyntheticWorkflowPolicy(
  route: ApprovalKindRoute,
  kind: ApprovalKind
): OrgApprovalWorkflowPolicy {
  const workflowQuorum = convertKindQuorumToWorkflowQuorum(
    route.quorum,
    route.approverUserIds.length
  );

  const stage: ApprovalLane = {
    id: `kind_${kind}_stage`,
    nameJa: `${kind}承認`,
    voterUserIds: route.approverUserIds,
    quorum: workflowQuorum,
    onReject: route.onExpire === "fail_closed" ? "fail_closed" : "count_as_vote",
  };

  return {
    version: 1,
    policyId: `kind_${kind}_${Date.now().toString(36)}`,
    policyName: `${kind}承認ルート`,
    stages: [stage],
    finalGoUserId: route.finalGoUserId ?? undefined,
    updatedAt: new Date().toISOString(),
    updatedBy: "kind_routes",
  };
}

/**
 * Check if an approval should use kind-based routing.
 * Returns the kind and route if applicable, null otherwise.
 */
export async function shouldUseKindRouting(
  approval: Pick<ApprovalRequest, "tool" | "orgId" | "employeeId">,
  ownerUserId?: string
): Promise<{
  kind: ApprovalKind;
  route: ApprovalKindRoute;
  syntheticPolicy: OrgApprovalWorkflowPolicy;
} | null> {
  if (!isApprovalKindRoutesEnabled()) {
    return null;
  }

  const kind = getToolApprovalKind(approval.tool);
  const effective = await getEffectiveApprovalKindRoute(
    approval.orgId,
    kind,
    approval.employeeId,
    ownerUserId
  );

  const syntheticPolicy = buildSyntheticWorkflowPolicy(effective.route, kind);

  return {
    kind,
    route: effective.route,
    syntheticPolicy,
  };
}

/**
 * Calculate expiry time for a kind route.
 * Returns null if no deadline is set.
 */
export function calculateKindRouteExpiry(route: ApprovalKindRoute): Date | null {
  if (!route.deadlineHours) {
    return null;
  }

  const now = new Date();
  return new Date(now.getTime() + route.deadlineHours * 60 * 60 * 1000);
}

/**
 * Check if approval has expired based on kind route settings.
 */
export function isKindRouteExpired(
  route: ApprovalKindRoute,
  createdAt: Date | string
): boolean {
  if (!route.deadlineHours) {
    return false;
  }

  const created = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  const expiry = new Date(created.getTime() + route.deadlineHours * 60 * 60 * 1000);
  return new Date() > expiry;
}

/**
 * Check expiry against stored deadline.
 */
export function isKindRouteExpiredByDeadline(
  deadlineAt: string | null | undefined
): boolean {
  if (!deadlineAt) {
    return false;
  }

  const deadline = new Date(deadlineAt);
  return new Date() > deadline;
}

/**
 * Determine if a reminder should be sent for a kind route.
 */
export function shouldSendKindRouteReminder(
  route: ApprovalKindRoute,
  createdAt: Date | string,
  lastReminderAt?: Date | string | null
): boolean {
  if (!route.remindEveryDays || route.remindEveryDays <= 0) {
    return false;
  }

  const now = new Date();
  const reference = lastReminderAt
    ? (typeof lastReminderAt === "string" ? new Date(lastReminderAt) : lastReminderAt)
    : (typeof createdAt === "string" ? new Date(createdAt) : createdAt);

  const daysSinceReference = (now.getTime() - reference.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceReference >= route.remindEveryDays;
}

/**
 * Build kind routing metadata to store in approval.metadata.kindRouting
 */
export function buildKindRoutingMetadata(
  kind: ApprovalKind,
  route: ApprovalKindRoute,
  policyId: string
): KindRoutingMetadata {
  const deadlineAt = calculateKindRouteExpiry(route);

  return {
    kind,
    policyId,
    routeSnapshot: route,
    deadlineAt: deadlineAt?.toISOString() ?? null,
    lastReminderAt: null,
    reminderCount: 0,
  };
}

/**
 * Parse kind routing metadata from approval.metadata.
 */
export function parseKindRoutingMetadata(
  metadata: Record<string, unknown> | null | undefined
): KindRoutingMetadata | null {
  if (!metadata) return null;

  const kr = metadata.kindRouting;
  if (!kr || typeof kr !== "object" || Array.isArray(kr)) return null;

  const parsed = kr as Partial<KindRoutingMetadata>;
  if (!parsed.kind || !parsed.policyId || !parsed.routeSnapshot) return null;

  return {
    kind: parsed.kind,
    policyId: parsed.policyId,
    routeSnapshot: parsed.routeSnapshot,
    deadlineAt: parsed.deadlineAt ?? null,
    lastReminderAt: parsed.lastReminderAt ?? null,
    reminderCount: parsed.reminderCount ?? 0,
  };
}

/**
 * Get the onExpire behavior for an approval with kind routing.
 */
export function getKindRouteOnExpire(
  metadata: Record<string, unknown> | null | undefined
): OnExpireBehavior | null {
  const kr = parseKindRoutingMetadata(metadata);
  if (!kr) return null;
  return kr.routeSnapshot.onExpire;
}

/**
 * Check if an approval is kind-routed.
 */
export function isKindRoutedApproval(
  approval: ApprovalRequest
): boolean {
  return parseKindRoutingMetadata(approval.metadata) !== null;
}

/**
 * Evaluate if an approval should expire based on kind routing.
 * Returns the action to take (fail_closed, keep_open) or null if not expired.
 */
export function evaluateKindRouteExpiry(
  approval: ApprovalRequest
): { expired: boolean; action: OnExpireBehavior | null; deadlineAt: string | null } {
  const kr = parseKindRoutingMetadata(approval.metadata);
  if (!kr) {
    return { expired: false, action: null, deadlineAt: null };
  }

  const expired = isKindRouteExpiredByDeadline(kr.deadlineAt);
  return {
    expired,
    action: expired ? kr.routeSnapshot.onExpire : null,
    deadlineAt: kr.deadlineAt ?? null,
  };
}

/**
 * Evaluate if a reminder should be sent for a kind-routed approval.
 */
export function evaluateKindRouteReminder(
  approval: ApprovalRequest
): { shouldRemind: boolean; daysSinceLastReminder: number; reminderCount: number } {
  const kr = parseKindRoutingMetadata(approval.metadata);
  if (!kr) {
    return { shouldRemind: false, daysSinceLastReminder: 0, reminderCount: 0 };
  }

  const shouldRemind = shouldSendKindRouteReminder(
    kr.routeSnapshot,
    approval.createdAt,
    kr.lastReminderAt
  );

  const now = new Date();
  const lastRef = kr.lastReminderAt
    ? new Date(kr.lastReminderAt)
    : new Date(approval.createdAt);
  const daysSinceLastReminder = (now.getTime() - lastRef.getTime()) / (1000 * 60 * 60 * 24);

  return {
    shouldRemind,
    daysSinceLastReminder,
    reminderCount: kr.reminderCount ?? 0,
  };
}
