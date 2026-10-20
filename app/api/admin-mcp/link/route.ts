import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { appendAdminAuditEvent, humanAdminActor } from "@/lib/audit/admin-audit";
import { adminAgentPublicView, linkOrgAdminAgent } from "@/lib/data/admin-agents";
import { jsonUtf8 } from "@/lib/http/json-utf8";

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
    await appendAdminAuditEvent({
      orgId: gate.orgId,
      employeeId: null,
      credentialId: agent.id,
      action: "admin.link",
      purpose: "admin.link",
      summary: "管理エージェントを接続（人のタップ）",
      actor: humanAdminActor(gate.email),
      metadata: { grokBotAgentId: agent.grokBotAgentId },
    });
    return jsonUtf8({ ok: true, agent: adminAgentPublicView(agent) });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : "link_failed";
    const status = code === "revoked" ? 403 : 400;
    return jsonUtf8({ ok: false, error: code || message, message }, { status });
  }
}
