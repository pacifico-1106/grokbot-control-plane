import { NextResponse } from "next/server";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  getEmployee,
  resolveApproval,
  runtimeModeLabel,
} from "@/lib/data";
import { requireCapability } from "@/lib/team/demo-actor";
import { SELF_APPROVAL_DENIED, SELF_APPROVAL_MESSAGE_JA } from "@/lib/admin-mcp/self-approval";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireCapability(req, "approve_actions");
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note || Array.from(note).length > 2_000) {
    return NextResponse.json(
      { error: "revision_note_must_be_1_to_2000_chars" },
      { status: 400 }
    );
  }

  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();
  let updated;
  try {
    updated = await resolveApproval(
      id,
      "revision_requested",
      gate.actor.email,
      orgId,
      { revisionNote: note, actorId: gate.actor.id }
    );
  } catch (error) {
    const code = (error as { code?: string }).code || (error instanceof Error ? error.message : "");
    if (code === SELF_APPROVAL_DENIED) {
      return NextResponse.json(
        { error: SELF_APPROVAL_DENIED, message: SELF_APPROVAL_MESSAGE_JA },
        { status: 403 }
      );
    }
    throw error;
  }
  if (!updated) {
    return NextResponse.json(
      { error: "not_found_or_already_resolved" },
      { status: 404 }
    );
  }

  const employee = await getEmployee(updated.employeeId, orgId || updated.orgId);
  const sideEffects = await runApprovalResolveSideEffects({
    approval: updated,
    decision: "revision_requested",
    actorEmail: gate.actor.email,
    employee,
  });

  return NextResponse.json({
    ok: true,
    approval: updated,
    sideEffects,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    actorId: gate.actor.id,
  });
}
