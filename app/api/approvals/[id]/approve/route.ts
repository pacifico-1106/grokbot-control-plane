import { NextResponse } from "next/server";
import { resolveRuntimeApproval } from "@/lib/demo-data";
import { sendApprovalNotification } from "@/lib/email";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const updated = resolveRuntimeApproval(id, "approved");
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await sendApprovalNotification(
    "owner@example.com",
    "approval_resolved",
    updated.summary,
    updated.risk
  );
  return NextResponse.json({ ok: true, approval: updated, demo: true });
}
