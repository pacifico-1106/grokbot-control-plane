/**
 * PR-D approver authority — public surface for PR-K / PR-L and channels.
 *
 * - APPROVER_AUTHORITY_TARGETS / classifyApproverRequirement: what a ticket needs.
 * - approverRequirementForFiling: used by createApproval (flag-gated).
 * - checkApproverAuthority / recordApproverAuthority: approval time.
 * - assertApproverAuthorityForExecution: right before fulfil.
 * - getVerifiedApprover: who approved (PR-L: "判定上の操作者は承認したオーナー").
 */
import type { ApprovalRequest } from "@/lib/types";

export * from "./targets";
export * from "./decide";
export {
  checkApproverAuthority,
  recordApproverAuthority,
  assertApproverAuthorityForExecution,
  ApproverAuthorityExecutionError,
} from "./verify";
export { approverRequirementForFiling } from "./filing";
export {
  approverRequirementCardLinesJa,
  approverAuthorityReplyJa,
  approverAuthorityNextStepJa,
  OWNER_APPROVAL_REQUIRED_JA,
} from "./card";
export {
  getDesignatedAdminMemberIds,
  validateDesignatedAdminIds,
  DESIGNATED_ADMINS_MAX,
} from "./designated-admins";

/**
 * The verified approver stored on an approved ticket, or null. Only meaningful
 * after executeApproval's re-check passed (fulfil handlers run after it).
 */
export function getVerifiedApprover(
  approval: ApprovalRequest
): { memberId: string; role: "owner" | "designated_admin" } | null {
  if (approval.status !== "approved") return null;
  const memberId = (approval.approverMemberId || "").trim();
  const role = approval.approverRole;
  if (!memberId || (role !== "owner" && role !== "designated_admin")) return null;
  return { memberId, role };
}
