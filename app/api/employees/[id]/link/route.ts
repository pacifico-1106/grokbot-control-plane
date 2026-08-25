import { NextResponse } from "next/server";
import { requireOrgSession } from "@/lib/auth/require-org";
import {
  bindingPublicView,
  getBinding,
  getEmployee,
  linkAgent,
  runtimeModeLabel,
} from "@/lib/data";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const employee = await getEmployee(id, gate.orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    grokBotAgentId?: string;
    grokBotWorkspaceId?: string | null;
  };

  try {
    const binding = await linkAgent(id, {
      orgId: employee.orgId || gate.orgId,
      grokBotAgentId: body.grokBotAgentId || "",
      grokBotWorkspaceId: body.grokBotWorkspaceId,
    });
    return NextResponse.json({
      ok: true,
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
      binding: bindingPublicView(binding),
      message: "Grok Bot エージェントを連携しました（employeeId は不変）",
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "revoked") {
      return NextResponse.json(
        {
          error: "revoked",
          message: "取り消された連携は再リンク不可（新規社員が必要）",
        },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: "agent_id_required", message: "grokBotAgentId が必要です" },
      { status: 400 }
    );
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const employee = await getEmployee(id, gate.orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }
  const binding = await getBinding(id);
  if (!binding || binding.orgId !== gate.orgId) {
    return NextResponse.json({ error: "binding_not_found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    binding: bindingPublicView(binding),
    mode: runtimeModeLabel(),
  });
}
