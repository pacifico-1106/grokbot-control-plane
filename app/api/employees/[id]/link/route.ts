import { NextResponse } from "next/server";
import { requireOrgAdminSession, requireOrgSession } from "@/lib/auth/require-org";
import { isMcpEndpointHandoffEnabled } from "@/lib/feature-flags";
import { buildMcpHandoff } from "@/lib/mcp/endpoint-handoff-block";
import {
  bindingPublicView,
  getBinding,
  getEmployee,
  linkAgent,
  runtimeModeLabel,
} from "@/lib/data";

export const runtime = "nodejs";

/**
 * Re-points the employee's binding at a Grok Bot agent (employee_bindings)
 * → org owner/admin only (server-side; members get 403 admin_required).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireOrgAdminSession();
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
      ...(isMcpEndpointHandoffEnabled() ? { mcpHandoff: buildMcpHandoff({ employeeId: id }) } : {}),
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
    ...(isMcpEndpointHandoffEnabled() ? { mcpHandoff: buildMcpHandoff({ employeeId: id }) } : {}),
  });
}
