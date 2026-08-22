import { NextResponse } from "next/server";
import {
  bindingPublicView,
  getBinding,
  linkAgent,
} from "@/lib/bindings";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const employee = getRuntimeEmployees().find((e) => e.id === id);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    grokBotAgentId?: string;
    grokBotWorkspaceId?: string | null;
  };

  try {
    const binding = linkAgent(id, {
      orgId: employee.orgId || DEMO_ORG.id,
      grokBotAgentId: body.grokBotAgentId || "",
      grokBotWorkspaceId: body.grokBotWorkspaceId,
    });
    return NextResponse.json({
      ok: true,
      demo: true,
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
  const { id } = await ctx.params;
  const binding = getBinding(id);
  if (!binding) {
    return NextResponse.json({ error: "binding_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, binding: bindingPublicView(binding) });
}
