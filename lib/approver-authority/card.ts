/**
 * PR-D: card / reply wording shared by Slack, LINE, Telegram and the web.
 * Plain text; each channel escapes it.
 */
import type { ApprovalRequest } from "@/lib/types";
// Namespace import: lib/notify/* load this module; a named import would make the
// flag a link-time dependency of every notify importer.
import * as featureFlags from "@/lib/feature-flags";
export {
  approverAuthorityReplyJa,
  approverAuthorityNextStepJa,
  approverAuthorityApprovedNoticeJa,
} from "./reply";

export const OWNER_APPROVAL_REQUIRED_JA = "オーナー承認が必要";

function endorsementCount(approval: ApprovalRequest): number {
  const list = approval.approverAuthority?.endorsements;
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Lines for the approval card: what is required and whose approval is pending.
 * Empty when the flag is OFF or the ticket is not a target (cards unchanged).
 */
export function approverRequirementCardLinesJa(approval: ApprovalRequest): string[] {
  if (!featureFlags.isApproverAuthorityEnabled()) return [];
  const kind = approval.requiredApproverKind;
  if (!kind) return [];
  if (approval.status !== "pending") return [];
  if (kind === "owner") {
    const endorsed = endorsementCount(approval);
    return [
      `🔐 ${OWNER_APPROVAL_REQUIRED_JA}（お金・権限に関わる変更）`,
      endorsed > 0
        ? `承認待ち: オーナー（いずれか1人・複数なら申請者以外。指定管理者 ${endorsed} 人は承認済み・オーナー承認まで反映しません）`
        : "承認待ち: オーナー（いずれか1人・オーナーが複数なら申請者以外）",
    ];
  }
  return ["🔐 承認できる人: オーナーまたは指定管理者", "承認待ち: オーナーまたは指定管理者"];
}
