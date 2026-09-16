import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ApprovalRequest } from "@/lib/types";
import { getOrgAdminAgent } from "@/lib/data/admin-agents";
import { parseAdminRequester } from "./self-approval";
import { assertPlatformOpsFromAdminCred } from "@/lib/admin/platform-ops-gate";

/** Check before fulfillment, pending poll-token disclosure, and result retrieval. */
export async function canReadAdminApproval(approval: ApprovalRequest, cred: ResolvedAdminCredential): Promise<boolean> {
  const requester = parseAdminRequester(approval.metadata);
  if (approval.orgId !== cred.orgId || !requester?.actorId || requester.actorId !== cred.actorId ||
      cred.adminAgentId !== cred.actorId ||
      (requester.grokBotAgentId && requester.grokBotAgentId !== cred.grokBotAgentId) ||
      (requester.credentialGeneration !== undefined && requester.credentialGeneration !== cred.generation)) return false;
  const current = await getOrgAdminAgent(cred.orgId);
  if (!current || current.id !== cred.adminAgentId || !["linked", "unlinked"].includes(current.status) ||
      !current.credentialFingerprint || current.credentialGeneration !== cred.generation ||
      current.grokBotAgentId !== cred.grokBotAgentId) return false;
  const tool = String(approval.metadata.adminTool || approval.tool || "");
  if (tool.startsWith("orgs.")) return (await assertPlatformOpsFromAdminCred(cred)).allowed;
  return true;
}
