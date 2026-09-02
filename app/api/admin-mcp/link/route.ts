import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { appendAuditEvent } from "@/lib/data";
import { adminAgentPublicView, linkOrgAdminAgent } from "@/lib/data/admin-agents";

export const runtime = "nodejs";

/** Human tap: bind the tenant admin Grok agent id. Not an always_human ticket. */
export async function POST(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as {
    grokBotAgentId?: string;
    grokBotWorkspaceId?: string | null;
  };
  try {
    const agent = await linkOrgAdminAgent({
      orgId: gate.orgId,
      grokBotAgentId: body.grokBotAgentId || "",
      grokBotWorkspaceId: body.grokBotWorkspaceId,
    });
    await appendAuditEvent({
      orgId: gate.orgId,
      employeeId: null,
      credentialId: agent.id,
      actorEmail: gate.email,
      action: "admin.link",
      purpose: "admin.link",
      summary: "管理エージェントを接続（人のタップ）",
      metadata: { grokBotAgentId: agent.grokBotAgentId },
    });
    return NextResponse.json({ ok: true, agent: adminAgentPublicView(agent) });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : "link_failed";
    const status = code === "revoked" ? 403 : 400;
    return NextResponse.json({ ok: false, error: code || message, message }, { status });
  }
}
