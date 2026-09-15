import { NextResponse } from "next/server";
import { getSuperAdminAccess } from "@/lib/admin/access";
import {
  proxyResolveApproval,
  PROXY_APPROVAL_MANDATES,
  type ProxyApprovalMandate,
} from "@/lib/admin/proxy-approve";

export const runtime = "nodejs";

/**
 * POST /api/admin/organizations/[orgId]/approvals/[approvalId]/resolve
 * Super admin only — proxy resolve a tenant's pending approval.
 * 
 * Request body:
 * - decision: "approved" | "rejected" (required)
 * - mandate: "setup" | "support" (required) - 名目
 * - note?: string (optional) - 自由記述メモ
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ orgId: string; approvalId: string }> }
) {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: access.reason === "unauthenticated" ? 401 : 403 }
    );
  }

  const { orgId, approvalId } = await ctx.params;
  if (!orgId || !approvalId) {
    return NextResponse.json(
      { ok: false, error: "org_id_and_approval_id_required" },
      { status: 400 }
    );
  }

  let body: { decision?: string; mandate?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 }
    );
  }

  const decision = (body.decision || "").trim();
  const mandate = (body.mandate || "").trim();
  const note = (body.note || "").trim();

  if (!decision || !["approved", "rejected"].includes(decision)) {
    return NextResponse.json(
      { ok: false, error: "invalid_decision", message: "decision は approved | rejected のいずれかを指定してください" },
      { status: 400 }
    );
  }

  if (!mandate || !PROXY_APPROVAL_MANDATES.includes(mandate as ProxyApprovalMandate)) {
    return NextResponse.json(
      { ok: false, error: "invalid_mandate", message: `名目(mandate)は ${PROXY_APPROVAL_MANDATES.join(" | ")} のいずれかを指定してください` },
      { status: 400 }
    );
  }

  try {
    const result = await proxyResolveApproval({
      targetOrgId: orgId,
      approvalId,
      decision: decision as "approved" | "rejected",
      mandate: mandate as ProxyApprovalMandate,
      note: note || undefined,
      actor: {
        email: access.actor.email,
        userId: access.actor.userId,
      },
    });

    if (!result.ok) {
      const statusCode = result.code === "approval_not_found" ? 404 : 400;
      return NextResponse.json(
        { ok: false, error: result.code, message: result.error },
        { status: statusCode }
      );
    }

    return NextResponse.json({
      ok: true,
      approval: result.approval,
      sideEffects: result.sideEffects,
      decision,
      mandate,
      actorEmail: access.actor.email,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
