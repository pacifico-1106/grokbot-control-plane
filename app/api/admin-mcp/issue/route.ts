import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { requireCredentialAdmin } from "@/lib/auth/require-credential-admin";
import { appendAuditEvent } from "@/lib/data";
import { adminAgentPublicView, issueOrgAdminAgent, mintAdminSecret } from "@/lib/data/admin-agents";
import { ADMIN_CREDENTIAL_PREFIX, staffpassAdminMcpUrl } from "@/lib/mcp/admin-public";

export const runtime = "nodejs";

/**
 * Human tap: issue the one-per-tenant admin MCP bearer (gb_adm_).
 * Not an employee badge. Not an always_human ticket.
 *
 * gb_adm_ can drive employees.issue (→ gb_emp_ after approval), so this is a
 * credential-issuing path: owner/admin + hire_issue_credentials, same as
 * gb_emp_ issue/rotate. Audit carries only a 12-char hash prefix.
 */
export async function POST(req: Request) {
  const gate = await requireCredentialAdmin(req);
  if (!gate.ok) return gate.response;
  const orgId = (await getCurrentOrgId()) || null;
  if (!orgId) {
    return NextResponse.json(
      { ok: false, error: "auth_required", message: "ログインと組織が必要です" },
      { status: 401 }
    );
  }
  const secret = mintAdminSecret();
  const agent = await issueOrgAdminAgent({
    orgId,
    secretHash: secret.hash,
    secretPrefix: secret.prefix,
  });
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: agent.id,
    actorEmail: gate.actor.email,
    action: "admin.link",
    purpose: "admin.link",
    summary: "管理MCPの認証を発行（人のタップ）",
    metadata: {
      generation: agent.credentialGeneration,
      prefix: ADMIN_CREDENTIAL_PREFIX,
      secretHashPrefix: secret.hash.slice(0, 12),
      actorMemberId: gate.actor.id,
    },
  });
  return NextResponse.json({
    ok: true,
    agent: adminAgentPublicView(agent),
    mcpUrl: staffpassAdminMcpUrl(),
    auth: {
      type: "bearer",
      scheme: `Authorization: Bearer ${ADMIN_CREDENTIAL_PREFIX}…`,
      notEmployeeBadge: true,
    },
    credential: {
      prefix: secret.prefix,
      oneTimeSecret: secret.raw,
      noticeJa:
        "この秘密値は社員証（gb_emp_）ではありません。管理MCP専用です。社員証ヘッダと混ぜないでください。一度だけ表示します。",
    },
  });
}
