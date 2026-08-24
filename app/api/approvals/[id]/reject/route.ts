import { NextResponse } from "next/server";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  getEmployee,
  resolveApproval,
  runtimeModeLabel,
} from "@/lib/data";
import { requireCapability } from "@/lib/team/demo-actor";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireCapability(req, "approve_actions");
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();
  const updated = await resolveApproval(id, "rejected", gate.actor.email, orgId);
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const employee = await getEmployee(updated.employeeId, orgId || updated.orgId);
  const sideEffects = await runApprovalResolveSideEffects({
    approval: updated,
    decision: "rejected",
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
