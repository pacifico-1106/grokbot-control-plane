/**
 * Platform super-admin: mint gb_adm_ for a target tenant after human approval.
 * Caller cred stays on platform ops org; issued credential scopes to targetOrgId.
 */
import type { PlatformOpsActor } from "@/lib/admin/platform-ops-gate";
import { getOrgMeta } from "@/lib/data/org-context";
import { issueOrgAdminAgent, mintAdminSecret } from "@/lib/data/admin-agents";
import { isDemoMode } from "@/lib/mode";
import { ADMIN_CREDENTIAL_PREFIX } from "@/lib/mcp/admin-public";

export type OrgIssueAdminCredentialInput = {
  targetOrgId: string;
  jobId?: string;
};

export type OrgIssueAdminCredentialSuccess = {
  targetOrgId: string;
  adminAgentId: string;
  secretPrefix: string;
  oneTimeSecret: string;
  credentialGeneration: number;
  summaryJa: string;
  nextStepJa: string;
  noticeJa: string;
};

export function validateOrgIssueAdminCredentialInput(
  args: Record<string, unknown>
):
  | { ok: true; value: OrgIssueAdminCredentialInput }
  | { ok: false; code: string; message: string } {
  const targetOrgId = String(args.orgId || args.targetOrgId || "").trim();
  if (!targetOrgId) {
    return { ok: false, code: "org_id_required", message: "orgId が必要です" };
  }
  const jobId = typeof args.jobId === "string" && args.jobId.trim() ? args.jobId.trim() : undefined;
  return { ok: true, value: { targetOrgId, jobId } };
}

export function queueOrgIssueAdminCredentialArgs(
  value: OrgIssueAdminCredentialInput,
  actor: PlatformOpsActor
): Record<string, unknown> {
  return {
    targetOrgId: value.targetOrgId,
    jobId: value.jobId,
    platformActorEmail: actor.email,
    platformActorUserId: actor.userId,
    platformActorOrgId: actor.orgId,
  };
}

export async function platformIssueAdminCredential(
  targetOrgId: string,
  _actor: PlatformOpsActor
): Promise<Omit<OrgIssueAdminCredentialSuccess, "oneTimeSecret"> & { oneTimeSecret: string }> {
  const id = targetOrgId.trim();
  if (!id) {
    throw Object.assign(new Error("org_id_required"), {
      code: "org_id_required",
      messageJa: "orgId が必要です",
    });
  }

  if (!isDemoMode()) {
    await getOrgMeta(id);
  }

  const secret = mintAdminSecret();
  const agent = await issueOrgAdminAgent({
    orgId: id,
    secretHash: secret.hash,
    secretPrefix: secret.prefix,
  });

  return {
    targetOrgId: id,
    adminAgentId: agent.id,
    secretPrefix: secret.prefix,
    oneTimeSecret: secret.raw,
    credentialGeneration: agent.credentialGeneration,
    summaryJa: `管理MCP認証（${ADMIN_CREDENTIAL_PREFIX}）を発行しました（対象 org: ${id.slice(0, 8)}…）`,
    nextStepJa:
      "発行した gb_adm_ を対象 org の Admin MCP ヘッダに設定してください。続けて employees.issue 等を対象 org スコープで実行できます。",
    noticeJa:
      "この秘密値は社員証（gb_emp_）ではありません。管理MCP専用です。社員証ヘッダと混ぜないでください。一度だけ表示します。",
  };
}

export async function fulfillOrgIssueAdminCredentialFromQueuedArgs(
  args: Record<string, unknown>,
  actor: PlatformOpsActor
): Promise<OrgIssueAdminCredentialSuccess> {
  const parsed = validateOrgIssueAdminCredentialInput({
    orgId: args.targetOrgId,
    jobId: args.jobId,
  });
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return platformIssueAdminCredential(parsed.value.targetOrgId, actor);
}
