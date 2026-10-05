/**
 * members.promoteOwner — オーナー追加 (八坂 2026-10-05 10:11, 木村 10:25).
 *
 *   Admin MCP files "make an EXISTING ACTIVE member of this org an owner".
 *   always_human; owner approval only (APPROVER_AUTHORITY_TARGETS.sensitiveTools).
 *   One existing owner approves; neither the requester nor the target may
 *   (approval time: workflow-integration; again here at fulfil).
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
import { promoteOwnerApproverConflict } from "@/lib/approver-authority/decide";
import { PROMOTE_OWNER_TOOL } from "@/lib/approver-authority/targets";
import type { ApprovalRequest } from "@/lib/types";

export { PROMOTE_OWNER_TOOL };

const FLAG_OFF_MESSAGE =
  "OWNER_PROMOTION_ENABLED と APPROVER_AUTHORITY_ENABLED の両方が ON のときだけ、オーナー追加の申請を使えます。";

function fail(code: string, message: string): ToolOutcome & { title?: string } {
  return { kind: "result", data: { ok: false, code, message }, isError: true };
}

export async function handlePromoteOwnerTool(
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<ToolOutcome & { title?: string }> {
  if (!isOwnerPromotionEnabled()) return fail("feature_disabled", FLAG_OFF_MESSAGE);
  // { memberId } only: no invite (email / role / capabilities), no orgId.
  const unsafe = rejectUnsafeArgs(args, ["memberId", "jobId"]);
  if (unsafe) return unsafe;
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
  return {
    kind: "queue",
    title: "オーナーの追加（既存オーナーの承認が必要）",
    queuedArgs: { memberId: target.id, beforeRole: target.role, beforeCapabilities },
    summary: [
      `既存のメンバー「${(target.displayName || "(名前なし)").replace(/[\r\n]+/g, " ").slice(0, 60)}」をオーナーにします。`,
      "承認できるのは既存のオーナー1名です。申請者と対象者本人は承認できません。",
      "承認されると、オーナー標準の権限が付き、オーナー全員と対象者に通知されます。",
      "",
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
  if (conflict === "approver_is_requester") return stop(conflict, "申請者は、このオーナー追加を承認できません。");

  const { applyOwnerPromotion } = await import("@/lib/team/apply-member-change");
  const applied = await applyOwnerPromotion({
    orgId,
    approverMemberId: approver.memberId,
    targetMemberId: memberId,
    expectedRole: typeof args.beforeRole === "string" ? args.beforeRole : "",
    expectedCapabilities: Array.isArray(args.beforeCapabilities) ? args.beforeCapabilities.map(String) : [],
    approvalId: approval.id,
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
