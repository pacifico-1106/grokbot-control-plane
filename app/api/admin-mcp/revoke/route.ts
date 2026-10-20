import { requireOrgOwnerSession } from "@/lib/auth/require-org";
import { ensureAdminRevokeAudit, humanAdminActor, sanitizeAdminRevokeReason } from "@/lib/audit/admin-audit";
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
  const parsedReason = sanitizeAdminRevokeReason(body.reason);
  if (!parsedReason.ok) {
    return jsonUtf8(
      { ok: false, error: parsedReason.error, message: "理由に使えない文字列です" },
      { status: 400 }
    );
  }
  const reason = parsedReason.reason;

  const existing = await getOrgAdminAgent(gate.orgId);
  if (!existing) {
    return jsonUtf8(
      { ok: false, error: "admin_agent_not_found", message: "管理用の認証がありません" },
      { status: 404 }
    );
  }
  const generation = existing.credentialGeneration;
  const actor = humanAdminActor(gate.email, gate.memberId);
  const writeAudit = () =>
    ensureAdminRevokeAudit({
      orgId: gate.orgId,
      credentialId: existing.id,
      generation,
      actor,
      reason,
    });
  const revoked = await revokeOrgAdminAgent({ orgId: gate.orgId });
  try {
    await writeAudit();
  } catch {
    await writeAudit().catch(() => undefined);
  }
  if (revoked.alreadyRevoked) {
    return jsonUtf8({ ok: true, alreadyRevoked: true });
  }

  return jsonUtf8({ ok: true, generation });
}
