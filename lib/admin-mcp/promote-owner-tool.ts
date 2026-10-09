/**
 * members.promoteOwner — オーナー追加 (八坂 2026-10-05 10:11, 木村 10:25).
 *
 *   Admin MCP files "make an EXISTING ACTIVE member of this org an owner".
 *   always_human; owner approval only (APPROVER_AUTHORITY_TARGETS.sensitiveTools).
 *   One existing owner approves (木村 2026-10-09): the member being promoted may
 *   NEVER approve; a sole owner may approve even their own request (same rule
 *   as PR-D, audited with singleOwnerApproval: true); with 2+ owners, an owner
 *   other than the requester. Nobody eligible → refused at filing (PR-D filing
 *   stop). Checked at approval time (workflow-integration) and again at fulfil.
 *   Fulfil: role=owner + the standard owner capabilities through the single
 *   member-change guard (applyOwnerPromotion → evaluateMemberChange), then
 *   every owner and the target are notified, and the change is audited.
 *
 * Not here (still under review): removing an owner, transferring ownership,
 * inviting someone as owner. Args are { memberId } only; orgId comes from the
 * credential (filing) / the approval row (fulfil).
 *
 * Requires OWNER_PROMOTION_ENABLED and APPROVER_AUTHORITY_ENABLED.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { rejectUnsafeArgs, type ToolOutcome } from "@/lib/admin-mcp/slack-dm-setup";
import { appendAuditEvent } from "@/lib/data/audit";
import { listMembers } from "@/lib/data/members";
import { isOwnerPromotionEnabled } from "@/lib/feature-flags";
import { getVerifiedApprover } from "@/lib/approver-authority";
import { promoteOwnerApproverConflict, requesterMemberIdsFromMetadata } from "@/lib/approver-authority/decide";
import { PROMOTE_OWNER_TOOL } from "@/lib/approver-authority/targets";
import type { ApprovalRequest } from "@/lib/types";
import { requesterCardLineJa, requesterMetadata, resolveAdminRequester, SLACK_USER_ID_FORMAT } from "@/lib/admin-mcp/requester-identity";

export { PROMOTE_OWNER_TOOL };

export const REQUESTER_NOT_IDENTIFIED = "requester_not_identified";
export const REQUESTER_NOT_IDENTIFIED_NEXT_STEP_JA =
  "依頼した人の Slack ID を requesterSlackUserId に入れて申請し直してください";

const FLAG_OFF_MESSAGE =
  "OWNER_PROMOTION_ENABLED と APPROVER_AUTHORITY_ENABLED の両方が ON のときだけ、オーナー追加の申請を使えます。";

function fail(code: string, message: string): ToolOutcome & { title?: string } {
  return { kind: "result", data: { ok: false, code, message }, isError: true };
}

export async function handlePromoteOwnerTool(
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<ToolOutcome & { title?: string; extraMetadata?: Record<string, unknown> }> {
  if (!isOwnerPromotionEnabled()) return fail("feature_disabled", FLAG_OFF_MESSAGE);
  // { memberId } only: no invite (email / role / capabilities), no orgId.
  // requesterSlackUserId: the person who asked the admin agent (#289 review). Never a member id.
  const unsafe = rejectUnsafeArgs(args, ["memberId", "jobId", "requesterSlackUserId"]);
  if (unsafe) return unsafe;
  let requesterSlackUserId: string | null = null;
  if (args.requesterSlackUserId !== undefined && args.requesterSlackUserId !== null && args.requesterSlackUserId !== "") {
    const raw = typeof args.requesterSlackUserId === "string" ? args.requesterSlackUserId.trim().toUpperCase() : "";
    if (!SLACK_USER_ID_FORMAT.test(raw)) {
      return fail("invalid_requester_slack_user_id", "requesterSlackUserId は依頼した人の Slack user ID（U…）で指定してください。");
    }
    requesterSlackUserId = raw;
  }
  const memberId = typeof args.memberId === "string" ? args.memberId.trim() : "";
  if (!memberId || memberId.length > 128) {
    return fail("member_id_required", "memberId（この組織の既存メンバーの ID）を指定してください。招待と同時のオーナー追加はできません。");
  }
  const members = (await listMembers(cred.orgId)).filter((m) => m.orgId === cred.orgId);
  const target = members.find((m) => m.id === memberId);
  if (!target) return fail("member_not_found", "この組織のメンバーが見つかりません。");
  if (target.status !== "active") {
    return fail("member_not_active", "有効なメンバーだけをオーナーにできます（招待中・停止中のメンバーは不可）。");
  }
  if (target.role === "owner") return fail("already_owner", "このメンバーはすでにオーナーです。");
  const beforeCapabilities = [...(target.capabilities ?? [])];
  const requester = await resolveAdminRequester(cred.orgId, requesterSlackUserId);
  // Option (c) (木村 2026-10-09 22:48): with 2+ active owners, "an owner other
  // than the requester" can only be enforced when the requester is known, so an
  // unidentified requester (not declared, or not matching an active verified
  // Slack approver binding of this org) is refused at filing. A sole owner keeps
  // the single-owner exception. Limit: requesterSlackUserId is declared by the
  // admin agent; the server checks it maps to a verified approver, not that this
  // person is the one who actually asked.
  const activeOwnerCount = members.filter((m) => m.role === "owner" && m.status === "active").length;
  if (activeOwnerCount >= 2 && !requester.identified) {
    return {
      kind: "result",
      isError: true,
      data: {
        ok: false,
        code: REQUESTER_NOT_IDENTIFIED,
        message:
          "オーナーが2人以上いるため、申請者以外のオーナーが承認する必要があります。依頼した人を承認者登録（Slack）で確認できないので、申請できません。",
        nextStepJa: REQUESTER_NOT_IDENTIFIED_NEXT_STEP_JA,
        requesterIdentity: { identified: false, reason: requester.reason },
      },
    };
  }
  return {
    kind: "queue",
    extraMetadata: requesterMetadata(requester),
    title: "オーナーの追加（既存オーナーの承認が必要）",
    queuedArgs: { memberId: target.id, beforeRole: target.role, beforeCapabilities, beforeStatus: target.status },
    summary: [
      `既存のメンバー「${(target.displayName || "(名前なし)").replace(/[\r\n]+/g, " ").slice(0, 60)}」をオーナーにします。`,
      "承認できるのは既存のオーナー1名です。対象者本人は承認できません。オーナーが2人以上いるときは、申請者以外のオーナーが承認します。",
      "承認されると、オーナー標準の権限が付き、オーナー全員と対象者に1回だけ通知されます。",
      "",
      requesterCardLineJa(requester),
      `■ 現在の席種別: ${target.role}`,
      "■ 変更後: owner（オーナー標準の権限）",
    ].join("\n"),
  };
}

export type PromoteOwnerFulfillResult =
  | { ok: true; memberId: string; summaryJa: string }
  | { ok: false; code: string; messageJa: string };

export async function fulfillPromoteOwner(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<PromoteOwnerFulfillResult> {
  const orgId = approval.orgId;
  const memberId = typeof args.memberId === "string" ? args.memberId.trim() : "";
  const stop = async (code: string, messageJa: string): Promise<PromoteOwnerFulfillResult> => {
    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `オーナー追加を中止（${code}）`,
      metadata: { auditClass: ADMIN_AUDIT_CLASS, event: "member.promote_owner.rejected", tool: PROMOTE_OWNER_TOOL, approvalId: approval.id, memberId: memberId || null, code },
    }).catch(() => undefined);
    return { ok: false, code, messageJa };
  };
  if (!isOwnerPromotionEnabled()) return stop("feature_disabled", FLAG_OFF_MESSAGE);
  const approver = getVerifiedApprover(approval);
  if (!approver || approver.role !== "owner") {
    return stop("owner_approval_required", "オーナー追加は既存オーナーの承認が必要です。オーナーの承認がありません。");
  }
  if (!memberId) return stop("member_id_required", "対象のメンバーが申請に含まれていません。");
  const conflict = promoteOwnerApproverConflict(
    { tool: PROMOTE_OWNER_TOOL, metadata: { ...(approval.metadata ?? {}), adminMutation: { memberId } } },
    approver.memberId
  );
  if (conflict === "approver_is_target") return stop(conflict, "オーナーに追加される本人は、この申請を承認できません。");
  // Requester: a sole owner may approve their own request; with 2+ owners, not.
  const activeOwners = (await listMembers(orgId)).filter((m) => m.orgId === orgId && m.role === "owner" && m.status === "active");
  const singleOwnerApproval = activeOwners.length === 1;
  if (!singleOwnerApproval && requesterMemberIdsFromMetadata(approval.metadata).includes(approver.memberId)) {
    return stop("approver_is_requester", "オーナーが2人以上いるときは、申請者以外のオーナーが承認してください。");
  }

  const { applyOwnerPromotion } = await import("@/lib/team/apply-member-change");
  const applied = await applyOwnerPromotion({
    orgId,
    approverMemberId: approver.memberId,
    targetMemberId: memberId,
    expectedRole: typeof args.beforeRole === "string" ? args.beforeRole : "",
    expectedCapabilities: Array.isArray(args.beforeCapabilities) ? args.beforeCapabilities.map(String) : [],
    // Tickets filed before beforeStatus existed: the target had to be active to be filed.
    expectedStatus: typeof args.beforeStatus === "string" ? (args.beforeStatus as "active") : "active",
    approvalId: approval.id,
    singleOwnerApproval,
  });
  if (!applied.ok) return stop(applied.code, applied.messageJa);

  try {
    const { notifyOwnerPromoted } = await import("@/lib/notify/channels");
    await notifyOwnerPromoted(approval, { targetMemberId: memberId, approverMemberId: approver.memberId });
  } catch { /* best effort; the promotion and its audit row stand */ }

  return {
    ok: true,
    memberId,
    summaryJa: `「${applied.member.displayName || applied.member.id}」をオーナーにしました（承認: ${applied.approver.displayName || applied.approver.id}）。`,
  };
}
