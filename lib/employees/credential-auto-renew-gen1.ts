/**
 * 社員証 auto-renew R8: gen1 HTTP one-time pickup.
 * Behind CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED + auto-renew org gate (default OFF).
 * Reuses credential_renewals CAS + overlap mint. Never logs secret / claim_token.
 */
import { getApprovalById } from "@/lib/data";
import { findOpenCredentialRenewalRow } from "@/lib/data/credential-renewals";
import { isCredentialAutoRenewGen1HttpEnabled } from "@/lib/feature-flags";
import {
  expireStaleCredentialRenewals,
  isCredentialAutoRenewOnForOrg,
} from "@/lib/employees/credential-auto-renew";
import {
  issueCredentialOverlap,
  type IssueCredentialOverlapResult,
} from "@/lib/employees/credential-auto-renew-overlap";

export { isCredentialAutoRenewGen1HttpEnabled };

const fail = (code: string, message: string): IssueCredentialOverlapResult => ({
  ok: false,
  code,
  message,
});

export async function claimCredentialGen1Http(input: {
  orgId: string;
  employeeId: string;
  oldCredentialId: string;
}): Promise<IssueCredentialOverlapResult> {
  if (!isCredentialAutoRenewGen1HttpEnabled() || !isCredentialAutoRenewOnForOrg(input.orgId)) {
    return fail("feature_disabled", "社員証の自動更新は無効です（CREDENTIAL_AUTO_RENEW_ENABLED / 許可リスト / GEN1 HTTP）。");
  }
  await expireStaleCredentialRenewals({ orgId: input.orgId }).catch(() => 0);
  const open = await findOpenCredentialRenewalRow(input.orgId, input.employeeId);
  if (open?.approvalId) {
    const approval = await getApprovalById(open.approvalId, input.orgId);
    if (!approval || approval.status !== "approved") {
      return fail("not_claimable", "受け取り窓が開いていません。");
    }
  }
  return issueCredentialOverlap({
    orgId: input.orgId,
    employeeId: input.employeeId,
    oldCredentialId: input.oldCredentialId,
    claimMode: "gen1_http",
  });
}
