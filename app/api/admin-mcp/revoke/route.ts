import { requireOrgOwnerSession } from "@/lib/auth/require-org";
import { appendAdminAuditEvent, humanAdminActor } from "@/lib/audit/admin-audit";
import { getOrgAdminAgent, revokeOrgAdminAgent } from "@/lib/data/admin-agents";
import { jsonUtf8 } from "@/lib/http/json-utf8";
import { aiCredentialPresented, refuseUnsafeBrowserPost } from "@/lib/safety/hold-route";

export const runtime = "nodejs";

/**
 * Human tap only: revoke the tenant gb_adm_ bearer (status=revoked, fingerprint null).
 * Owner session. Never an admin MCP tool. AI credentials (gb_adm_ / gb_emp_) are refused.
 */
export async function POST(req: Request) {
  if (aiCredentialPresented(req)) {
    return jsonUtf8(
      {
        ok: false,
        error: "ai_cannot_revoke",
        message: "AI の資格情報では管理用の認証を失効できません。人がダッシュボードから操作してください。",
      },
      { status: 403 }
    );
  }
  const csrf = refuseUnsafeBrowserPost(req);
  if (csrf) return csrf;

  const gate = await requireOrgOwnerSession();
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";

  const existing = await getOrgAdminAgent(gate.orgId);
  if (!existing) {
    return jsonUtf8(
      { ok: false, error: "admin_agent_not_found", message: "管理用の認証がありません" },
      { status: 404 }
    );
  }
  const generation = existing.credentialGeneration;
  const revoked = await revokeOrgAdminAgent({ orgId: gate.orgId });
  if (revoked.alreadyRevoked) {
    return jsonUtf8({ ok: true, alreadyRevoked: true });
  }

  await appendAdminAuditEvent({
    orgId: gate.orgId,
    employeeId: null,
    credentialId: existing.id,
    action: "admin.revoke",
    purpose: "admin.revoke",
    summary: "管理用の認証を失効（人のタップ）",
    actor: humanAdminActor(gate.email, gate.memberId),
    metadata: {
      generation,
      ...(reason ? { reason } : {}),
    },
  });

  return jsonUtf8({ ok: true, generation });
}
