/**
 * 社員証 reissue pickup claim (#332 follow-up, ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED).
 * Production: public.claim_credential_reissue / release_credential_reissue
 * (migration 20261012200000) — one conditional UPDATE, exactly one winner.
 * Demo: the same compare-and-set in process (no await between check and set).
 * Ids + a random claim token only; never key material.
 */
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isDemoMode } from "@/lib/mode";
import { demoGetApproval, demoUpdateApproval } from "@/lib/data/demo-approvals-store";

const TOOL = "employees.credential.reissue";
/** Demo CAS authority: approvalId → claim token (process-local). */
const demoClaims = new Map<string, string>();

export interface ClaimInput {
  approvalId: string;
  orgId: string;
  token: string;
  memberId: string | null;
  at: string;
}

export async function claimCredentialReissueTicket(input: ClaimInput): Promise<boolean> {
  if (!input.token || input.token.length < 16) throw new Error("invalid_claim_token");
  if (isDemoMode()) {
    const row = await demoGetApproval(input.approvalId);
    if (!row || row.orgId !== input.orgId || row.status !== "approved") return false;
    if (String(row.metadata?.adminTool || row.tool || "") !== TOOL) return false;
    const mark = row.metadata?.credentialReissue as Record<string, unknown> | undefined;
    // check + set with no await in between (single-threaded → atomic in process)
    if (demoClaims.has(input.approvalId) || (mark && mark.redeemedAt)) return false;
    demoClaims.set(input.approvalId, input.token);
    const fresh = (await demoGetApproval(input.approvalId)) ?? row;
    await demoUpdateApproval(input.approvalId, {
      metadata: {
        ...fresh.metadata,
        credentialReissue: { claimToken: input.token, redeemedAt: input.at, redeemedByMemberId: input.memberId },
      },
    });
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("claim_credential_reissue", {
    p_id: input.approvalId,
    p_org: input.orgId,
    p_token: input.token,
    p_member: input.memberId,
    p_at: input.at,
  });
  if (error) throw new Error("reissue_claim_failed");
  return data === true;
}

/** Releases ONLY the mark set with this token (and org). */
export async function releaseCredentialReissueTicket(input: { approvalId: string; orgId: string; token: string }): Promise<boolean> {
  if (!input.token) return false;
  if (isDemoMode()) {
    const row = await demoGetApproval(input.approvalId);
    if (!row || row.orgId !== input.orgId) return false;
    if (demoClaims.get(input.approvalId) !== input.token) return false;
    const mark = row.metadata?.credentialReissue as Record<string, unknown> | undefined;
    if (!mark || mark.claimToken !== input.token) return false;
    demoClaims.delete(input.approvalId);
    const metadata = { ...row.metadata };
    delete metadata.credentialReissue;
    await demoUpdateApproval(input.approvalId, { metadata });
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("release_credential_reissue", {
    p_id: input.approvalId,
    p_org: input.orgId,
    p_token: input.token,
  });
  if (error) return false;
  return data === true;
}
