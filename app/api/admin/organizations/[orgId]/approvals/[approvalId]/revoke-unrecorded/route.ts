import { NextResponse } from "next/server";
import { getSuperAdminAccess } from "@/lib/admin/access";
import {
  REVOKE_UNRECORDED_MESSAGES_JA,
  REVOKE_UNRECORDED_NEXT_STEP_JA,
  revokeUnrecordedApproval,
  revokeUnrecordedHttpStatus,
} from "@/lib/approver-authority/recovery";
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
    const nextStep = REVOKE_UNRECORDED_NEXT_STEP_JA[result.code];
    return NextResponse.json(
      { ok: false, error: result.code, message: REVOKE_UNRECORDED_MESSAGES_JA[result.code], ...(nextStep ? { nextStep } : {}) },
      { status: revokeUnrecordedHttpStatus(result.code) }
    );
  }
  return NextResponse.json({ ok: true, approval: publicApproval(result.approval) });
}
