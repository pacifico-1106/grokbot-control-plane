import type { ApprovalRequest } from "@/lib/types";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { demoUpdateApproval } from "@/lib/data/demo-approvals-store";
import { canReadAdminApproval } from "./result-authority";
const consumedDemo = new Set<string>();

/** Call only through the credential-authenticated result endpoint. */
export async function consumeAdminApprovalSecret(approval: ApprovalRequest, cred: ResolvedAdminCredential): Promise<string | null> {
  if (!(await canReadAdminApproval(approval, cred))) return null;
  if (isDemoMode()) {
    const key = `${approval.orgId}:${approval.id}`;
    if (consumedDemo.has(key) || approval.metadata.adminSecretConsumed) return null;
    const metadata = structuredClone(approval.metadata);
    const fulfillment = (metadata.adminFulfillment ?? metadata.fulfillment) as { ok?: boolean; oneTimeSecret?: string } | undefined;
    if (!fulfillment?.ok || !fulfillment.oneTimeSecret) return null;
    const secret = fulfillment.oneTimeSecret;
    consumedDemo.add(key); // synchronous claim before the first write/await
    for (const name of ["adminFulfillment", "fulfillment"]) {
      const value = metadata[name] as Record<string, unknown> | undefined;
      if (value) delete value.oneTimeSecret;
    }
    metadata.adminSecretConsumed = true;
    await demoUpdateApproval(approval.id, { metadata });
    approval.metadata = metadata;
    return secret;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("approval_secret_unavailable");
  const { data, error } = await admin.rpc("consume_admin_approval_secret", {
    p_id: approval.id, p_org: cred.orgId, p_actor: cred.actorId, p_generation: cred.generation,
  });
  if (error) throw new Error("approval_secret_unavailable");
  return typeof data === "string" ? data : null;
}
