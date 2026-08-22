import { NextResponse } from "next/server";
import {
  bindingPublicView,
  ensureBindingRow,
  getBinding,
  recordHealthFailure,
  recordHealthSuccess,
} from "@/lib/bindings";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";

export const runtime = "nodejs";

/**
 * Health probe stub.
 * linked && not revoked → success; ?forceFail=1 for demo break.
 * Failure sets needs_reauth (要再連携) — never silent reset.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const employee = getRuntimeEmployees().find((e) => e.id === id);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  ensureBindingRow(id, employee.orgId || DEMO_ORG.id);
  const url = new URL(req.url);
  const forceFail =
    url.searchParams.get("forceFail") === "1" ||
    url.searchParams.get("forceFail") === "true";

  const before = getBinding(id)!;
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
    const binding = recordHealthFailure(id, "forced_demo_failure")!;
    return NextResponse.json({
      ok: false,
      demo: true,
      code: "needs_reauth",
      binding: bindingPublicView(binding),
      message: "ヘルス失敗 → 要再連携（バインディングは保持）",
    });
  }

  if (!before.grokBotAgentId || before.status === "unlinked") {
    return NextResponse.json({
      ok: false,
      demo: true,
      code: "unbound",
      binding: bindingPublicView(before),
      message: "未連携のためヘルス失敗",
    });
  }

  const binding = recordHealthSuccess(id)!;
  return NextResponse.json({
    ok: true,
    demo: true,
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
