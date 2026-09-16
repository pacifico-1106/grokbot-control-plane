import type { ApprovalRequest } from "@/lib/types";
import { isDemoMode } from "@/lib/mode";
import { isApprovalAuthorityCurrent } from "@/lib/auth/approval-authority";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { getOrgAdminAgent } from "@/lib/data/admin-agents";
import { assertPlatformOpsFromAdminCred } from "@/lib/admin/platform-ops-gate";
import { getEmployee } from "@/lib/data/employees";
import { employeeHasToolScope, resolveGatewayTool } from "@/lib/gateway/tools";
import { assertBillingAllowsGateway } from "@/lib/billing/entitlements";

export async function assertApprovalExecutionAuthority(approval: ApprovalRequest): Promise<void> {
  if (approval.status !== "approved") throw new Error("approval_not_approved");
  const raw = approval.metadata.invoke;
  const snapshot = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (snapshot && ((snapshot.orgId && snapshot.orgId !== approval.orgId) ||
      (snapshot.employeeId && snapshot.employeeId !== approval.employeeId) ||
      (snapshot.tool && approval.tool && snapshot.tool !== approval.tool))) throw new Error("approval_target_mismatch");
  // Demo has no Auth/DB credential authority. Its fixtures remain simulation only.
  if (isDemoMode()) return;
  if (!(await isApprovalAuthorityCurrent(approval, { throwOnUnavailable: true }))) throw new Error("approval_authority_revoked");
  if (isAdminClassApproval(approval)) {
    const tool = String(approval.metadata.adminTool || approval.tool || "");
    if (tool.startsWith("orgs.")) {
      const agent = await getOrgAdminAgent(approval.orgId);
      if (!agent || !(await assertPlatformOpsFromAdminCred({ orgId: agent.orgId, adminAgentId: agent.id,
        actorId: agent.id, grokBotAgentId: agent.grokBotAgentId, generation: agent.credentialGeneration,
        via: "bearer", agent })).allowed) throw new Error("platform_ops_forbidden");
    }
    return;
  }
  const employee = await getEmployee(approval.employeeId, approval.orgId);
  const tool = resolveGatewayTool(String(snapshot?.tool || approval.tool || ""));
  if (!employee || employee.orgId !== approval.orgId || employee.status !== "active" || !tool.ok ||
      !employeeHasToolScope(employee.scopes, tool.def) || employee.toolApprovalDefaults?.[tool.def.id] === "deny" ||
      (employee.allowedPurposes?.length && !employee.allowedPurposes.includes(String(snapshot?.purpose || approval.purpose)))) {
    throw new Error("approval_authority_revoked");
  }
  if (!(await assertBillingAllowsGateway(approval.orgId, tool.def.id)).ok) throw new Error("expired_trial_gated");
}
