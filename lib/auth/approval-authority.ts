import { createSupabaseAdminClient } from "../supabase";
import { isAdminClassApproval } from "../admin-mcp/audit-class";
import { parseAdminRequester } from "../admin-mcp/self-approval";

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
    // Old tickets did not snapshot the generation. Preserve their existing
    // polling contract; do not infer a historical generation during migration.
    // Rotation invalidation is guaranteed only for new generation-bound tickets.
    return requester.credentialGeneration === undefined ||
      (Number.isSafeInteger(requester.credentialGeneration) &&
       requester.credentialGeneration === agent.credential_generation);
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
