/**
 * Web API for Approval Kind Routes
 *
 * GET: Retrieve current policy for the org
 * POST: Submit a change request (files approvalRoutes.patch via approval workflow)
 *
 * Owner/admin only. Changes do NOT apply directly but file always_human approvalRoutes.patch.
 */
import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { isApprovalKindRoutesEnabled } from "@/lib/feature-flags";
import { assertApiPlanAllows } from "@/lib/billing/plan-api-gate";
import {
  getOrgApprovalKindRoutesPolicy,
  getEffectiveApprovalKindRoute,
} from "@/lib/approval-kind-routes/data";
import type { OrgApprovalKindRoutesPolicy, ApprovalKindRoute } from "@/lib/approval-kind-routes/types";
import { APPROVAL_KINDS } from "@/lib/approval-kind-routes/types";
import { createApproval, appendAuditEvent } from "@/lib/data";
import { sendApprovalNotifications } from "@/lib/notify/channels";

export const runtime = "nodejs";

function jsonError(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/**
 * Basic validation for policy structure.
 * Full validation with member checks happens on fulfillment via MCP handler.
 */
function validatePolicyBasic(policy: OrgApprovalKindRoutesPolicy): string[] {
  const errors: string[] = [];

  if (!policy.routes || !Array.isArray(policy.routes)) {
    errors.push("routes_required");
    return errors;
  }

  if (policy.routes.length === 0) {
    errors.push("routes_empty");
    return errors;
  }

  const seenKinds = new Set<string>();
  for (const route of policy.routes as ApprovalKindRoute[]) {
    if (!route.kind || !APPROVAL_KINDS.includes(route.kind)) {
      errors.push(`invalid_kind: ${route.kind}`);
      continue;
    }

    if (seenKinds.has(route.kind)) {
      errors.push(`duplicate_kind: ${route.kind}`);
    }
    seenKinds.add(route.kind);

    if (!route.approverUserIds || !Array.isArray(route.approverUserIds) || route.approverUserIds.length === 0) {
      errors.push(`empty_approvers: ${route.kind}`);
    }

    if (!route.quorum || typeof route.quorum !== "object") {
      errors.push(`invalid_quorum: ${route.kind}`);
    }
  }

  return errors;
}

/**
 * GET /api/approval-routes
 * Returns the current approval kind routes policy for the authenticated org.
 */
export async function GET() {
  const session = await getSessionContext();
  const orgId = session.orgId;
  if (!orgId) return jsonError("auth_required", 401);

  const member = session.member;
  if (!member || !["owner", "admin"].includes(member.role)) {
    return jsonError("owner_or_admin_required", 403);
  }

  if (!isApprovalKindRoutesEnabled()) {
    return NextResponse.json({
      ok: true,
      enabled: false,
      policy: null,
      message: "P1_APPROVAL_KIND_ROUTES_ENABLED is OFF",
    });
  }

  const policy = await getOrgApprovalKindRoutesPolicy(orgId);

  const effectiveRoutes: Record<string, unknown> = {};
  for (const kind of APPROVAL_KINDS) {
    effectiveRoutes[kind] = await getEffectiveApprovalKindRoute(orgId, kind, null);
  }

  return NextResponse.json({
    ok: true,
    enabled: true,
    policy,
    effectiveRoutes,
    orgId,
  });
}

/**
 * POST /api/approval-routes
 * Submit a change request for approval kind routes.
 * Does NOT apply directly — files an always_human approvalRoutes.patch approval request.
 */
export async function POST(req: Request) {
  const session = await getSessionContext();
  const orgId = session.orgId;
  if (!orgId) return jsonError("auth_required", 401);

  const member = session.member;
  if (!member || !["owner", "admin"].includes(member.role)) {
    return jsonError("owner_or_admin_required", 403);
  }

  if (!isApprovalKindRoutesEnabled()) {
    return jsonError("feature_disabled", 403);
  }

  const planGate = await assertApiPlanAllows(orgId, "approval_routes", "承認ルート設定の変更");
  if (!planGate.ok) return planGate.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const proposedPolicy = body.policy as OrgApprovalKindRoutesPolicy | undefined;
  const beforeStateHash = body.beforeStateHash as string | undefined;

  if (!proposedPolicy) {
    return jsonError("policy_required", 400);
  }

  const currentPolicy = await getOrgApprovalKindRoutesPolicy(orgId);
  const currentHash = currentPolicy
    ? Buffer.from(JSON.stringify(currentPolicy)).toString("base64").slice(0, 32)
    : "";

  if (beforeStateHash !== undefined && beforeStateHash !== currentHash) {
    await appendAuditEvent({
      orgId,
      employeeId: "",
      credentialId: "",
      actorEmail: member.email,
      action: "approval_routes.patch_conflict",
      purpose: null,
      summary: "承認ルート変更: before-state mismatch (Web API)",
      metadata: {
        expectedHash: beforeStateHash,
        actualHash: currentHash,
        source: "web_api",
      },
    });
    return jsonError("before_state_mismatch", 409);
  }

  const validationErrors = validatePolicyBasic(proposedPolicy);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { ok: false, error: "validation_failed", errors: validationErrors },
      { status: 400 }
    );
  }

  const diff = buildPolicyDiff(currentPolicy, proposedPolicy);

  const approval = await createApproval({
    orgId,
    employeeId: "",
    credentialId: "",
    tool: "approvalRoutes.patch",
    title: "承認ルート設定の変更",
    summary: buildDiffSummary(diff),
    purpose: "web_api_settings",
    jobId: `approval-routes-${Date.now()}`,
    risk: "high",
    metadata: {
      source: "web_api",
      beforeStateHash: currentHash,
      actorEmail: member.email,
      actorMemberId: member.id,
      diff,
      artifact: JSON.stringify({ before: currentPolicy, after: proposedPolicy }, null, 2),
    },
  });

  await sendApprovalNotifications(approval.approval, null);

  await appendAuditEvent({
    orgId,
    employeeId: "",
    credentialId: "",
    actorEmail: member.email,
    action: "approval.requested",
    purpose: "web_api_settings",
    summary: "承認ルート変更リクエストを作成 (Web API)",
    metadata: {
      approvalId: approval.approval.id,
      tool: "approvalRoutes.patch",
      source: "web_api",
    },
  });

  return NextResponse.json({
    ok: true,
    code: "needs_approval",
    approvalId: approval.approval.id,
    message: "承認リクエストを作成しました。承認後に設定が適用されます。",
  });
}

function buildPolicyDiff(
  before: OrgApprovalKindRoutesPolicy | null,
  after: OrgApprovalKindRoutesPolicy
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};

  if (!before) {
    changes.type = "create";
    changes.routes = after.routes;
  } else {
    changes.type = "update";
    const routeChanges: Record<string, unknown>[] = [];

    for (const route of after.routes) {
      const beforeRoute = before.routes.find((r) => r.kind === route.kind);
      if (!beforeRoute) {
        routeChanges.push({ kind: route.kind, change: "added", after: route });
      } else if (JSON.stringify(beforeRoute) !== JSON.stringify(route)) {
        routeChanges.push({
          kind: route.kind,
          change: "modified",
          before: beforeRoute,
          after: route,
        });
      }
    }

    for (const beforeRoute of before.routes) {
      if (!after.routes.find((r) => r.kind === beforeRoute.kind)) {
        routeChanges.push({ kind: beforeRoute.kind, change: "removed", before: beforeRoute });
      }
    }

    changes.routes = routeChanges;
  }

  return changes;
}

function buildDiffSummary(diff: Record<string, unknown>): string {
  const parts: string[] = [];

  if (diff.type === "create") {
    parts.push("新規作成");
  } else {
    const routeChanges = diff.routes as { kind: string; change: string }[];
    const added = routeChanges.filter((r) => r.change === "added").length;
    const modified = routeChanges.filter((r) => r.change === "modified").length;
    const removed = routeChanges.filter((r) => r.change === "removed").length;

    if (added) parts.push(`${added}件追加`);
    if (modified) parts.push(`${modified}件変更`);
    if (removed) parts.push(`${removed}件削除`);
  }

  return `承認ルート設定: ${parts.join(", ")}`;
}
