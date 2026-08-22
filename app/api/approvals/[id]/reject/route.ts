import { NextResponse } from "next/server";
import { resolveRuntimeApproval } from "@/lib/demo-data";
import { requireCapability } from "@/lib/team/demo-actor";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = requireCapability(req, "approve_actions");
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const updated = resolveRuntimeApproval(id, "rejected", gate.actor.email);
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    approval: updated,
    demo: true,
    actorId: gate.actor.id,
  });
}
