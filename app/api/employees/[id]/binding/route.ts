import { NextResponse } from "next/server";
import {
  bindingPublicView,
  ensureBindingRow,
  getBinding,
} from "@/lib/bindings";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const employee = getRuntimeEmployees().find((e) => e.id === id);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }
  const binding =
    getBinding(id) ?? ensureBindingRow(id, employee.orgId || DEMO_ORG.id);
  return NextResponse.json({
    ok: true,
    demo: true,
    binding: bindingPublicView(binding),
  });
}
