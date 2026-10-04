import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import {
  bindingPublicView,
  ensureBindingRow,
  getBinding,
  getEmployee,
  recordHealthFailure,
  recordHealthSuccess,
  runtimeModeLabel,
} from "@/lib/data";
import { isDemoMode } from "@/lib/mode";

export const runtime = "nodejs";

/**
 * Health probe stub.
 * linked && not revoked → success; ?forceFail=1 simulates a break in DEMO
 * mode only (ignored in production, so nobody can force needs_reauth).
 * Failure sets needs_reauth (要再連携) — never silent reset.
 * Writes the binding (ensure row / status / last_success_at) → org
 * owner/admin only (members 403, unauthenticated 401).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const orgId = gate.orgId;
  const { id } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  await ensureBindingRow(id, employee.orgId || orgId);
  const url = new URL(req.url);
  const forceFail =
    isDemoMode() &&
    (url.searchParams.get("forceFail") === "1" ||
      url.searchParams.get("forceFail") === "true");

  const before = (await getBinding(id))!;
  if (before.status === "revoked") {
    return NextResponse.json(
      {
        ok: false,
        code: "revoked",
        binding: bindingPublicView(before),
        message: "revoked — health cannot recover",
      },
      { status: 403 }
    );
  }

  if (forceFail) {
    const binding = (await recordHealthFailure(id, "forced_demo_failure"))!;
    return NextResponse.json({
      ok: false,
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
      code: "needs_reauth",
      binding: bindingPublicView(binding),
      message: "ヘルス失敗 → 要再連携（バインディングは保持）",
    });
  }

  if (!before.grokBotAgentId || before.status === "unlinked") {
    return NextResponse.json({
      ok: false,
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
      code: "unbound",
      binding: bindingPublicView(before),
      message: "未連携のためヘルス失敗",
    });
  }

  const binding = (await recordHealthSuccess(id))!;
  return NextResponse.json({
    ok: true,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    binding: bindingPublicView(binding),
    message: "ヘルス成功",
    lastSuccessAt: binding.lastSuccessAt,
  });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  return POST(req, ctx);
}
