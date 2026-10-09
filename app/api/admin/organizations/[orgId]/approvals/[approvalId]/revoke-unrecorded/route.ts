import { NextResponse } from "next/server";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { REVOKE_UNRECORDED_MESSAGES_JA, revokeUnrecordedApproval } from "@/lib/approver-authority/recovery";
import { publicApproval } from "@/lib/approvals/public";

export const runtime = "nodejs";

/**
 * POST /api/admin/organizations/[orgId]/approvals/[approvalId]/revoke-unrecorded
 * Platform operator (super admin) only — review 2026-10-09 item 5. Same
 * narrow state as the owner route.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ orgId: string; approvalId: string }> }) {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: access.reason === "unauthenticated" ? 401 : 403 });
  }
  const { orgId, approvalId } = await ctx.params;
  const result = await revokeUnrecordedApproval({ orgId, approvalId, actor: { kind: "operator", email: access.actor.email } });
  if (!result.ok) {
    const status = result.code === "approval_not_found" ? 404 : result.code === "not_recoverable" ? 409 : 500;
    return NextResponse.json({ ok: false, error: result.code, message: REVOKE_UNRECORDED_MESSAGES_JA[result.code] }, { status });
  }
  return NextResponse.json({ ok: true, approval: publicApproval(result.approval) });
}
