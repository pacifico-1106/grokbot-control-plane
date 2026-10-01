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
  const diffSummary = generatePolicyDiff(beforeSnapshot, policy as unknown as OrgApprovalKindRoutesPolicy);

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

export interface FulfillApprovalRoutesPatchResult {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface DeputyActivateInput {
  approvalId: string;
  deputyUserId: string;
  reason?: string;
}

export interface DeputyActivateResult {
  ok: boolean;
  code?: string;
  message?: string;
  approvalId?: string;
  statusToken?: string;
  pollUrl?: string;
}

/**
 * Fulfill approvalRoutes.patch after always_human approval.
 *
 * This is called by fulfill-admin.ts after the approval ticket is approved.
 * - Re-runs validation
 * - Checks before-state match (rejects if state changed since filing)
 * - Persists the new policy
 * - Writes audit record (who filed, who approved, the diff)
 */
export async function fulfillApprovalRoutesPatch(
  approval: import("@/lib/types").ApprovalRequest,
  args: Record<string, unknown>
): Promise<FulfillApprovalRoutesPatchResult> {
  const { appendAuditEvent } = await import("@/lib/data/audit");
  const { setOrgApprovalKindRoutesPolicy } = await import("./data");
  const { isApprovalKindRoutesEnabled } = await import("@/lib/feature-flags");

  if (!isApprovalKindRoutesEnabled()) {
    return {
      ok: false,
      code: "feature_disabled",
      message: "P1_APPROVAL_KIND_ROUTES_ENABLED is OFF",
    };
  }

  // Extract the before/after snapshots from approval metadata
  const meta = approval.metadata || {};
  const argsSnapshot = meta.argsSnapshot as Record<string, unknown> | undefined;
  if (!argsSnapshot) {
    return {
      ok: false,
      code: "missing_args_snapshot",
      message: "承認チケットにスナップショットがありません",
    };
  }

  const beforeSnapshot = argsSnapshot.beforeSnapshot as OrgApprovalKindRoutesPolicy | null;
  const afterSnapshot = argsSnapshot.afterSnapshot as Record<string, unknown> | undefined;
  const diffSummary = argsSnapshot.diffSummary as string[] | undefined;

  if (!afterSnapshot) {
    return {
      ok: false,
      code: "missing_after_snapshot",
      message: "変更後のポリシーがありません",
    };
  }

  // Check before-state match
  const { matches, currentState } = await checkBeforeStateMatch(approval.orgId, beforeSnapshot);
  if (!matches) {
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId: null,
      credentialId: null,
      action: "approval_routes.patch_conflict",
      purpose: "admin.policy",
      summary: "承認ルート更新が競合しました（変更前の状態が一致しません）",
      metadata: {
        approvalId: approval.id,
        expectedPolicyId: beforeSnapshot?.policyId ?? null,
        currentPolicyId: currentState?.policyId ?? null,
        resolvedBy: approval.resolvedBy,
      },
    });

    return {
      ok: false,
      code: "before_state_mismatch",
      message: "承認時点で設定が変更されていました。再度お試しください。",
    };
  }

  // Re-run validation
  const ctx = await buildValidatorContext(approval.orgId, null);
  const validation = validateApprovalRoutes(afterSnapshot, ctx);
  if (!validation.ok) {
    return {
      ok: false,
      code: "validation_failed",
      message: "ポリシーの検証に失敗しました",
    };
  }

  // Persist the new policy
  const saved = await setOrgApprovalKindRoutesPolicy(
    approval.orgId,
    afterSnapshot as unknown as OrgApprovalKindRoutesPolicy
  );

  if (!saved) {
    return {
      ok: false,
      code: "save_failed",
      message: "ポリシーの保存に失敗しました",
    };
  }

  // Write audit record
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "approval_routes.patch",
    purpose: "admin.policy",
    summary: "承認ルート設定を更新しました（管理MCP・人承認後）",
    metadata: {
      approvalId: approval.id,
      policyId: (afterSnapshot as { policyId?: string }).policyId,
      filedBy: (meta.invoke as { actorId?: string })?.actorId ?? null,
      approvedBy: approval.resolvedBy,
      diff: diffSummary,
    },
  });

  return {
    ok: true,
    message: "承認ルート設定を更新しました",
  };
}

/**
 * Handle decision.deputyActivate — file always_human approval for deputy activation.
 *
 * Security:
 * - Self-approval forbidden (deputy cannot be the requester)
 * - Cross-org forbidden (deputy must be in same org)
 * - Creates always_human approval ticket
 */
export async function handleDeputyActivate(
  cred: ResolvedAdminCredential,
  args: DeputyActivateInput
): Promise<DeputyActivateResult> {
  const { isDecisionWorkflowEnabled } = await import("@/lib/feature-flags");
  const { getApprovalById, createApproval } = await import("@/lib/data/approvals");
  const { appendAuditEvent } = await import("@/lib/data/audit");
  const { listMembers } = await import("@/lib/data/members");
  const {
    validateDeputyActivation,
    buildDeputyActivationApprovalMetadata,
  } = await import("@/lib/decision-workflow/deputy");

  if (!isDecisionWorkflowEnabled()) {
    return {
      ok: false,
      code: "decision_workflow_disabled",
      message: "P1_DECISION_WORKFLOW_ENABLED is OFF",
    };
  }

  const { approvalId, deputyUserId, reason } = args;

  if (!approvalId || !deputyUserId) {
    return {
      ok: false,
      code: "invalid_input",
      message: "approvalId and deputyUserId are required",
    };
  }

  const originalApproval = await getApprovalById(approvalId, cred.orgId);
  if (!originalApproval) {
    return {
      ok: false,
      code: "approval_not_found",
      message: "Original approval not found",
    };
  }

  const metadata = originalApproval.metadata as Record<string, unknown> | null;
  if (metadata?.type !== "decision_request") {
    return {
      ok: false,
      code: "not_decision_request",
      message: "Original approval is not a decision request",
    };
  }

  const members = await listMembers(cred.orgId);
  const deputyMember = members.find((m) => m.userId === deputyUserId || m.id === deputyUserId);

  const validation = validateDeputyActivation(
    {
      approvalId,
      deputyUserId,
      requesterId: originalApproval.employeeId,
      requesterOrgId: originalApproval.orgId,
      reason,
    },
    deputyMember?.orgId ?? null
  );

  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      message: validation.message,
    };
  }

  const deputyMetadata = buildDeputyActivationApprovalMetadata(
    originalApproval,
    deputyUserId,
    reason
  );

  const result = await createApproval({
    orgId: cred.orgId,
    employeeId: originalApproval.employeeId,
    credentialId: cred.actorId ?? "",
    title: `決裁代理委任: ${originalApproval.title}`,
    purpose: "decision.deputy_activate",
    summary: `決裁 ${originalApproval.id} の代理を ${deputyUserId} に委任します\n理由: ${reason ?? "指定なし"}`,
    risk: "medium",
    tool: "decision.deputyActivate",
    jobId: `deputy_${approvalId}_${deputyUserId}`,
    metadata: deputyMetadata,
  });

  await appendAuditEvent({
    orgId: cred.orgId,
    employeeId: originalApproval.employeeId,
    credentialId: cred.actorId ?? "",
    action: "decision.deputy_activated",
    purpose: "decision.deputy_activate",
    summary: `決裁代理委任を申請: ${deputyUserId}`,
    metadata: {
      approvalId: result.approval.id,
      originalApprovalId: approvalId,
      deputyUserId,
      reason,
    },
  });

  return {
    ok: true,
    approvalId: result.approval.id,
    statusToken: result.statusToken,
    pollUrl: result.pollUrl,
    message: "決裁代理委任を申請しました（人承認が必要です）",
  };
}

export interface FulfillDeputyActivateResult {
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * Fulfill decision.deputyActivate after always_human approval.
 *
 * Security:
 * - Re-validates self-approval forbidden at fulfill time
 * - Re-validates cross-org forbidden at fulfill time
 * - Records decision.deputy_activated audit
 */
export async function fulfillDeputyActivate(
  approval: import("@/lib/types").ApprovalRequest,
  _args: Record<string, unknown>
): Promise<FulfillDeputyActivateResult> {
  const { isDecisionWorkflowEnabled } = await import("@/lib/feature-flags");
  const { getApprovalById } = await import("@/lib/data/approvals");
  const { appendAuditEvent } = await import("@/lib/data/audit");
  const { listMembers } = await import("@/lib/data/members");
  const {
    validateDeputyActivation,
    recordDeputyActivation,
    isDeputyActivationRequest,
  } = await import("@/lib/decision-workflow/deputy");

  if (!isDecisionWorkflowEnabled()) {
    return {
      ok: false,
      code: "decision_workflow_disabled",
      message: "P1_DECISION_WORKFLOW_ENABLED is OFF",
    };
  }

  if (!isDeputyActivationRequest(approval)) {
    return {
      ok: false,
      code: "not_deputy_activation",
      message: "This approval is not a deputy activation request",
    };
  }

  const metadata = approval.metadata as Record<string, unknown>;
  const originalApprovalId = metadata.originalApprovalId as string;
  const deputyUserId = metadata.deputyUserId as string;

  if (!originalApprovalId || !deputyUserId) {
    return {
      ok: false,
      code: "invalid_metadata",
      message: "Missing originalApprovalId or deputyUserId in approval metadata",
    };
  }

  const originalApproval = await getApprovalById(originalApprovalId, approval.orgId);
  if (!originalApproval) {
    return {
      ok: false,
      code: "original_not_found",
      message: "Original decision approval not found",
    };
  }

  const members = await listMembers(approval.orgId);
  const deputyMember = members.find((m) => m.userId === deputyUserId || m.id === deputyUserId);

  const validation = validateDeputyActivation(
    {
      approvalId: originalApprovalId,
      deputyUserId,
      requesterId: originalApproval.employeeId,
      requesterOrgId: originalApproval.orgId,
    },
    deputyMember?.orgId ?? null
  );

  if (!validation.ok) {
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId: approval.employeeId,
      credentialId: approval.credentialId,
      action: "decision.deputy_activated",
      purpose: approval.purpose,
      summary: `決裁代理委任が拒否されました: ${validation.message}`,
      metadata: {
        approvalId: approval.id,
        originalApprovalId,
        deputyUserId,
        rejectionCode: validation.code,
        rejectionMessage: validation.message,
      },
    });

    return {
      ok: false,
      code: validation.code,
      message: validation.message,
    };
  }

  await recordDeputyActivation(
    originalApproval,
    deputyUserId,
    approval.resolvedBy ?? "system"
  );

  return {
    ok: true,
    message: `決裁 ${originalApprovalId} の代理を ${deputyUserId} に委任しました`,
  };
}
