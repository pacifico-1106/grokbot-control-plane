import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { webSessionActorMemberId } from "@/lib/approver-authority/web-direct";
import {
  REVOKE_UNRECORDED_MESSAGES_JA,
  REVOKE_UNRECORDED_NEXT_STEP_JA,
  revokeUnrecordedApproval,
  revokeUnrecordedHttpStatus,
} from "@/lib/approver-authority/recovery";
import { publicApproval } from "@/lib/approvals/public";

export const runtime = "nodejs";

/**
 * POST /api/approvals/[id]/revoke-unrecorded — owner only (review 2026-10-09
 * item 5). Revokes an approved ticket whose final-approver record failed to
 * save (approved, approver class set, no approver, not fulfilled). The org is
 * the session org; the actor is the session member and must be an active owner.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();
  if (!orgId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const memberId = await webSessionActorMemberId(req);
  if (!memberId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const result = await revokeUnrecordedApproval({ orgId, approvalId: id, actor: { kind: "owner", memberId } });
  if (!result.ok) {
    const nextStep = REVOKE_UNRECORDED_NEXT_STEP_JA[result.code];
    return NextResponse.json(
      { ok: false, error: result.code, message: REVOKE_UNRECORDED_MESSAGES_JA[result.code], ...(nextStep ? { nextStep } : {}) },
      { status: revokeUnrecordedHttpStatus(result.code) }
    );
  }
  return NextResponse.json({ ok: true, approval: publicApproval(result.approval) });
}
