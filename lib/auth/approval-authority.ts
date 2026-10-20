import { createSupabaseAdminClient } from "../supabase";
import { isAdminClassApproval } from "../admin-mcp/audit-class";
import { parseAdminRequester } from "../admin-mcp/self-approval";

/** Old tickets omitted credentialGeneration. After a reissue they must not stay valid. */
export function isLegacyAdminRequesterStillValid(input: {
  credentialGeneration: number | undefined;
  currentGeneration: number;
  hasReissueAudit: boolean;
}): boolean {
  if (input.credentialGeneration !== undefined) {
    return (
      Number.isSafeInteger(input.credentialGeneration) &&
      input.credentialGeneration === input.currentGeneration
    );
  }
  return input.currentGeneration <= 1 && !input.hasReissueAudit;
}

function isAdminCredentialReissueAudit(event: {
  action: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  const meta = event.metadata || {};
  if (event.action === "admin.issue_admin_credential") {
    return Number(meta.issuedGeneration ?? meta.generation) > 1;
  }
  if (event.action === "admin.link" && meta.prefix === "gb_adm_") {
    return Number(meta.generation) > 1;
  }
  return false;
}

async function hasAdminCredentialReissueAudit(orgId: string): Promise<boolean> {
  const { listAuditEvents } = await import("@/lib/data/audit");
  const events = await listAuditEvents(orgId, 200);
  return events.some(isAdminCredentialReissueAudit);
}

/** Recheck current authority at poll/decision/delivery time, not just at issue. */
export async function isApprovalAuthorityCurrent(input: {
  orgId: string; employeeId: string; credentialId: string;
  purpose?: string | null; metadata?: Record<string, unknown> | null;
}, options: { throwOnUnavailable?: boolean } = {}): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  if (!input.employeeId && !input.credentialId && isAdminClassApproval(input)) {
    const requester = parseAdminRequester(input.metadata);
    if (!requester?.actorId) return false;
    const { data: agent, error } = await admin.from("org_admin_agents")
      .select("id,status,credential_fingerprint,credential_generation,grok_bot_agent_id")
      .eq("id", requester.actorId).eq("org_id", input.orgId).maybeSingle();
    if (error && options.throwOnUnavailable) throw new Error("authority_lookup_unavailable");
    if (error || !agent || !["linked", "unlinked"].includes(agent.status) ||
        !agent.credential_fingerprint || agent.credential_generation < 1) return false;
    if (requester.grokBotAgentId && requester.grokBotAgentId !== agent.grok_bot_agent_id) return false;
    const currentGeneration = Number(agent.credential_generation);
    if (requester.credentialGeneration === undefined) {
      if (currentGeneration > 1) return false;
      const hasReissueAudit = await hasAdminCredentialReissueAudit(input.orgId).catch(() => false);
      return isLegacyAdminRequesterStillValid({
        credentialGeneration: undefined,
        currentGeneration,
        hasReissueAudit,
      });
    }
    return (
      Number.isSafeInteger(requester.credentialGeneration) &&
      requester.credentialGeneration === currentGeneration
    );
  }
  if (!input.employeeId || !input.credentialId) return false;
  const { data: credential, error } = await admin.from("credentials")
    .select("secret_hash,revoked_at,expires_at")
    .eq("id", input.credentialId).eq("org_id", input.orgId)
    .eq("employee_id", input.employeeId).maybeSingle();
  if (error && options.throwOnUnavailable) throw new Error("authority_lookup_unavailable");
  if (error || !credential || credential.revoked_at) return false;
  if (credential.expires_at && (!Number.isFinite(Date.parse(credential.expires_at)) || Date.parse(credential.expires_at) <= Date.now())) return false;
  const { data: employee, error: employeeError } = await admin.from("employees").select("status")
    .eq("id", input.employeeId).eq("org_id", input.orgId).maybeSingle();
  const { data: binding, error: bindingError } = await admin.from("employee_bindings").select("status,credential_fingerprint")
    .eq("employee_id", input.employeeId).eq("org_id", input.orgId).maybeSingle();
  if (employeeError || bindingError) {
    if (options.throwOnUnavailable) throw new Error("authority_lookup_unavailable");
    return false;
  }
  return employee?.status === "active" && binding?.status === "linked" &&
    binding.credential_fingerprint === credential.secret_hash;
}
