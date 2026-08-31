import { NextResponse } from "next/server";
import { resendPendingApprovalNotifications } from "@/lib/approvals/notify";
import { requireOrgSession } from "@/lib/auth/require-org";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const result = await resendPendingApprovalNotifications(id, gate.orgId);
  return NextResponse.json(result.body, { status: result.status });
}
