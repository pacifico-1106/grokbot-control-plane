import { publicApproval } from "@/lib/approvals/public";
import { NextResponse } from "next/server";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { listPendingApprovalsForOrg } from "@/lib/admin/proxy-approve";

export const runtime = "nodejs";

/**
 * GET /api/admin/organizations/[orgId]/approvals
 * Super admin only — list pending approvals for a specific tenant org.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ orgId: string }> }
) {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: access.reason === "unauthenticated" ? 401 : 403 }
    );
  }

  const { orgId } = await ctx.params;
  if (!orgId) {
    return NextResponse.json(
      { ok: false, error: "org_id_required" },
      { status: 400 }
    );
  }

  try {
    const approvals = await listPendingApprovalsForOrg(orgId);
    return NextResponse.json({
      ok: true,
      approvals: approvals.map(publicApproval),
      count: approvals.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
