/**
 * P1 Approval Kind Routes — MCP Handlers
 *
 * Admin MCP handlers for approvalRoutes.get and approvalRoutes.patch.
 * These handlers use the shared validateApprovalRoutes for validation.
 *
 * Security:
 * - approvalRoutes.get is read-only (no approval ticket)
 * - approvalRoutes.patch is always_human, approvalClass admin
 * - Route changes require diff card and before-state match check
 */

import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import {
  getOrgApprovalKindRoutesPolicy,
  getEmployeeApprovalKindRoutesOverride,
  getAllEffectiveApprovalKindRoutes,
} from "./data";
import { getEffectiveApprovalWorkflowPolicy } from "@/lib/approval-workflow";
import { validateApprovalRoutes, type ValidatorContext } from "./validate";
import type { OrgApprovalKindRoutesPolicy, ApprovalKind } from "./types";
import { APPROVAL_KINDS } from "./types";
import { isApprovalKindRoutesEnabled } from "@/lib/feature-flags";

export interface ApprovalRoutesGetResult {
  ok: boolean;
  enabled: boolean;
  orgPolicy: OrgApprovalKindRoutesPolicy | null;
  employeeOverride: Record<string, unknown> | null;
  effectiveRoutes: Record<ApprovalKind, {
    route: unknown;
    source: "org" | "employee" | "default";
  }>;
  legacyWorkflowPolicy: unknown | null;
  code?: string;
  message?: string;
}

/**
 * Handle approvalRoutes.get (read-only).
 *
 * Returns the effective approval routes for all kinds.
 * When P1_APPROVAL_KIND_ROUTES_ENABLED is OFF, returns legacy workflow info.
 */
export async function handleApprovalRoutesGet(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<ApprovalRoutesGetResult> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;

  const enabled = isApprovalKindRoutesEnabled();

  // Get legacy workflow policy for comparison/migration info
  const legacyWorkflow = await getEffectiveApprovalWorkflowPolicy(cred.orgId, employeeId);

  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      orgPolicy: null,
      employeeOverride: null,
      effectiveRoutes: {} as Record<ApprovalKind, { route: unknown; source: "org" | "employee" | "default" }>,
      legacyWorkflowPolicy: legacyWorkflow.policy,
      message: "P1_APPROVAL_KIND_ROUTES_ENABLED is OFF. Using legacy approval workflow.",
    };
  }

  const orgPolicy = await getOrgApprovalKindRoutesPolicy(cred.orgId);
  const employeeOverride = employeeId
    ? await getEmployeeApprovalKindRoutesOverride(employeeId, cred.orgId)
    : null;

  const effectiveRoutes = await getAllEffectiveApprovalKindRoutes(
    cred.orgId,
    employeeId,
    undefined // ownerUserId will be resolved by the function
  );

  const formattedRoutes = {} as Record<ApprovalKind, { route: unknown; source: "org" | "employee" | "default" }>;
  for (const kind of APPROVAL_KINDS) {
    formattedRoutes[kind] = {
      route: effectiveRoutes[kind].route,
      source: effectiveRoutes[kind].source,
    };
  }

  return {
    ok: true,
    enabled: true,
    orgPolicy,
    employeeOverride: employeeOverride?.routes ?? null,
    effectiveRoutes: formattedRoutes,
    legacyWorkflowPolicy: legacyWorkflow.policy,
  };
}

export interface ApprovalRoutesPatchInput {
  employeeId?: string | null;
  clearOverride?: boolean;
  policyName?: string;
  routes?: unknown[];
  topicGate?: unknown;
  decisionWorkflow?: unknown;
}

export interface ApprovalRoutesPatchResult {
  ok: boolean;
  code?: string;
  message?: string;
  validationErrors?: unknown[];
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
  diffSummary?: string[];
}

/**
 * Build validator context from org data.
 */
export async function buildValidatorContext(
  orgId: string,
  requesterId?: string | null
): Promise<ValidatorContext> {
  // In a real implementation, this would fetch org members from the database
  // For now, return a placeholder that can be filled in during integration
  return {
    orgOwnerUserIds: [],
    orgAdminUserIds: [],
    orgHumanMemberUserIds: [],
    aiEmployeeUserIds: [],
    requesterId: requesterId ?? null,
  };
}

/**
 * Generate diff summary between two policies.
 */
export function generatePolicyDiff(
  before: OrgApprovalKindRoutesPolicy | null,
  after: OrgApprovalKindRoutesPolicy
): string[] {
  const diffs: string[] = [];

  if (!before) {
    diffs.push("新規ポリシーを作成します");
    for (const route of after.routes) {
      diffs.push(`  - ${route.kind}: 承認者 ${route.approverUserIds.length}名`);
    }
    return diffs;
  }

  // Compare policy name
  if (before.policyName !== after.policyName) {
    diffs.push(`ポリシー名: "${before.policyName}" → "${after.policyName}"`);
  }

  // Compare routes
  const beforeRoutes = new Map(before.routes.map((r) => [r.kind, r]));
  const afterRoutes = new Map(after.routes.map((r) => [r.kind, r]));

  for (const kind of APPROVAL_KINDS) {
    const beforeRoute = beforeRoutes.get(kind);
    const afterRoute = afterRoutes.get(kind);

    if (!beforeRoute && afterRoute) {
      diffs.push(`${kind}: 新規追加（承認者 ${afterRoute.approverUserIds.length}名）`);
    } else if (beforeRoute && !afterRoute) {
      diffs.push(`${kind}: 削除`);
    } else if (beforeRoute && afterRoute) {
      const changes: string[] = [];

      // Compare approvers
      const beforeApprovers = new Set(beforeRoute.approverUserIds);
      const afterApprovers = new Set(afterRoute.approverUserIds);
      const added = [...afterApprovers].filter((a) => !beforeApprovers.has(a));
      const removed = [...beforeApprovers].filter((a) => !afterApprovers.has(a));
      if (added.length > 0) changes.push(`承認者追加: ${added.join(", ")}`);
      if (removed.length > 0) changes.push(`承認者削除: ${removed.join(", ")}`);

      // Compare quorum
      if (JSON.stringify(beforeRoute.quorum) !== JSON.stringify(afterRoute.quorum)) {
        changes.push(`quorum: ${JSON.stringify(beforeRoute.quorum)} → ${JSON.stringify(afterRoute.quorum)}`);
      }

      // Compare finalGo
      if (beforeRoute.finalGoUserId !== afterRoute.finalGoUserId) {
        changes.push(`finalGo: ${beforeRoute.finalGoUserId || "なし"} → ${afterRoute.finalGoUserId || "なし"}`);
      }

      // Compare deadline
      if (beforeRoute.deadlineHours !== afterRoute.deadlineHours) {
        changes.push(`期限: ${beforeRoute.deadlineHours || "なし"} → ${afterRoute.deadlineHours || "なし"}`);
      }

      // Compare onExpire
      if (beforeRoute.onExpire !== afterRoute.onExpire) {
        changes.push(`期限切れ動作: ${beforeRoute.onExpire} → ${afterRoute.onExpire}`);
      }

      if (changes.length > 0) {
        diffs.push(`${kind}: ${changes.join(", ")}`);
      }
    }
  }

  // Compare topic gate
  if (JSON.stringify(before.topicGate) !== JSON.stringify(after.topicGate)) {
    diffs.push("話題ゲート設定が変更されました");
  }

  // Compare decision workflow
  if (JSON.stringify(before.decisionWorkflow) !== JSON.stringify(after.decisionWorkflow)) {
    diffs.push("決裁ワークフロー設定が変更されました");
  }

  if (diffs.length === 0) {
    diffs.push("変更はありません");
  }

  return diffs;
}

/**
 * Validate patch input and prepare for approval ticket.
 *
 * This is called during MCP patch filing (before creating the approval ticket).
 * The same validation is also run in the Web save API and before persist after approval.
 */
export async function validateApprovalRoutesPatch(
  cred: ResolvedAdminCredential,
  input: ApprovalRoutesPatchInput
): Promise<ApprovalRoutesPatchResult> {
  const ctx = await buildValidatorContext(cred.orgId, cred.actorId);

  // Build the policy from input
  const policy: Record<string, unknown> = {
    version: 1,
    policyId: `akr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    policyName: input.policyName || "承認ルート設定",
    routes: input.routes || [],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };

  if (input.topicGate !== undefined) {
    policy.topicGate = input.topicGate;
  }

  if (input.decisionWorkflow !== undefined) {
    policy.decisionWorkflow = input.decisionWorkflow;
  }

  // Validate
  const validation = validateApprovalRoutes(policy, ctx);
  if (!validation.ok) {
    return {
      ok: false,
      code: "validation_failed",
      message: "入力値の検証に失敗しました",
      validationErrors: validation.errors,
    };
  }

  // Get before snapshot
  const beforeSnapshot = await getOrgApprovalKindRoutesPolicy(cred.orgId);

  // Generate diff
  const diffSummary = generatePolicyDiff(beforeSnapshot, policy as OrgApprovalKindRoutesPolicy);

  return {
    ok: true,
    beforeSnapshot,
    afterSnapshot: policy,
    diffSummary,
  };
}

/**
 * Check if the before-state still matches.
 *
 * This is called just before persisting after approval.
 * If the stored 'before' state no longer matches, the save is rejected.
 */
export async function checkBeforeStateMatch(
  orgId: string,
  expectedBefore: OrgApprovalKindRoutesPolicy | null
): Promise<{ matches: boolean; currentState: OrgApprovalKindRoutesPolicy | null }> {
  const currentState = await getOrgApprovalKindRoutesPolicy(orgId);

  // Both null
  if (expectedBefore === null && currentState === null) {
    return { matches: true, currentState };
  }

  // One null, one not
  if (expectedBefore === null || currentState === null) {
    return { matches: false, currentState };
  }

  // Compare policyId and updatedAt
  const matches =
    expectedBefore.policyId === currentState.policyId &&
    expectedBefore.updatedAt === currentState.updatedAt;

  return { matches, currentState };
}
