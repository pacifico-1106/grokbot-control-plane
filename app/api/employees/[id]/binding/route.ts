import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  bindingPublicView,
  ensureBindingRow,
  getBinding,
  getEmployee,
  runtimeModeLabel,
} from "@/lib/data";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();
  const employee = await getEmployee(id, orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }
  const binding =
    (await getBinding(id)) ??
    (await ensureBindingRow(id, employee.orgId || orgId || ""));
  return NextResponse.json({
    ok: true,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    binding: bindingPublicView(binding),
  });
}
