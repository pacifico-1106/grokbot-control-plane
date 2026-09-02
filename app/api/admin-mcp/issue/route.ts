import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { appendAuditEvent } from "@/lib/data";
import { adminAgentPublicView, issueOrgAdminAgent, mintAdminSecret } from "@/lib/data/admin-agents";
import { ADMIN_CREDENTIAL_PREFIX, STAFFPASS_ADMIN_MCP_URL } from "@/lib/mcp/admin-public";

export const runtime = "nodejs";

/**
 * Human tap: issue the one-per-tenant admin MCP bearer (gb_adm_).
 * Not an employee badge. Not an always_human ticket.
 */
export async function POST() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const secret = mintAdminSecret();
  const agent = await issueOrgAdminAgent({
    orgId: gate.orgId,
    secretHash: secret.hash,
    secretPrefix: secret.prefix,
  });
  await appendAuditEvent({
    orgId: gate.orgId,
    employeeId: null,
    credentialId: agent.id,
    actorEmail: gate.email,
    action: "admin.link",
    purpose: "admin.link",
    summary: "管理MCPの認証を発行（人のタップ）",
    metadata: { generation: agent.credentialGeneration, prefix: ADMIN_CREDENTIAL_PREFIX },
  });
  return NextResponse.json({
    ok: true,
    agent: adminAgentPublicView(agent),
    mcpUrl: STAFFPASS_ADMIN_MCP_URL,
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
