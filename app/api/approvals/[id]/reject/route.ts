import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { resolveApproval, runtimeModeLabel } from "@/lib/data";
import { requireCapability } from "@/lib/team/demo-actor";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = requireCapability(req, "approve_actions");
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();
  const updated = await resolveApproval(id, "rejected", gate.actor.email, orgId);
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    approval: updated,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    actorId: gate.actor.id,
  });
}
