/**
 * PR-D: 指定管理者 (designated admins) on the admin MCP.
 *
 *   approvers.designatedAdmins.get  read-only (no ticket)
 *   approvers.designatedAdmins.set  always_human; OWNER approval required
 *                                   (APPROVER_AUTHORITY_TARGETS.sensitiveTools)
 *
 * Both require APPROVER_AUTHORITY_ENABLED. orgId comes from the credential
 * (queue) / the approval row (fulfil) only; there is no orgId argument.
 * Fulfil re-validates the list against the CURRENT members and refuses unless
 * the verified approver on the ticket is an owner (defence in depth on top of
 * executeApproval's re-check).
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { rejectUnsafeArgs, type ToolOutcome } from "@/lib/admin-mcp/slack-dm-setup";
import { appendAuditEvent } from "@/lib/data/audit";
import { listMembers } from "@/lib/data/members";
import { isApproverAuthorityEnabled } from "@/lib/feature-flags";
import {
  getDesignatedAdminMemberIds,
  validateDesignatedAdminIds,
  writeDesignatedAdminMemberIds,
} from "@/lib/approver-authority/designated-admins";
import { getVerifiedApprover } from "@/lib/approver-authority";
import { DESIGNATED_ADMINS_GET_TOOL, DESIGNATED_ADMINS_SET_TOOL } from "@/lib/approver-authority/targets";
import type { ApprovalRequest } from "@/lib/types";

export { DESIGNATED_ADMINS_GET_TOOL, DESIGNATED_ADMINS_SET_TOOL };
export const DESIGNATED_ADMINS_TOOLS = [DESIGNATED_ADMINS_GET_TOOL, DESIGNATED_ADMINS_SET_TOOL] as const;

export function isDesignatedAdminsTool(name: string): boolean {
  return (DESIGNATED_ADMINS_TOOLS as readonly string[]).includes(name);
}

const FLAG_OFF = {
  ok: false,
  code: "feature_disabled",
  message: "APPROVER_AUTHORITY_ENABLED が OFF のため、指定管理者の設定は使えません。",
};

async function describeMembers(orgId: string, ids: readonly string[]) {
  const members = (await listMembers(orgId)).filter((m) => m.orgId === orgId);
  return ids.map((id) => {
    const member = members.find((m) => m.id === id);
    return member
      ? { memberId: id, displayName: member.displayName || null, role: member.role, status: member.status }
      : { memberId: id, displayName: null, role: null, status: "not_found" };
  });
}

export async function handleDesignatedAdminsTool(
  name: string,
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<ToolOutcome & { title?: string }> {
  if (!isApproverAuthorityEnabled()) return { kind: "result", data: FLAG_OFF, isError: true };
  if (name === DESIGNATED_ADMINS_GET_TOOL) {
    const unsafe = rejectUnsafeArgs(args, []);
    if (unsafe) return unsafe;
    let ids: string[];
    try {
      ids = await getDesignatedAdminMemberIds(cred.orgId);
    } catch {
      return { kind: "result", data: { ok: false, code: "designated_admins_unavailable", message: "指定管理者の設定を読めませんでした。" }, isError: true };
    }
    return {
      kind: "result",
      data: {
        ok: true,
        tool: name,
        designatedAdmins: await describeMembers(cred.orgId, ids),
        noteJa: "承認者や権限を変える変更は、オーナーまたはここに並んだ指定管理者が承認できます。お金・権限に関わる変更はオーナーの承認が必要です。この一覧を変えられるのはオーナーだけです。",
      },
    };
  }
  const unsafe = rejectUnsafeArgs(args, ["memberIds", "jobId"]);
  if (unsafe) return unsafe;
  const validation = await validateDesignatedAdminIds(cred.orgId, args.memberIds);
  if (!validation.ok) {
    return { kind: "result", data: { ok: false, code: validation.code, message: validation.messageJa, invalid: validation.invalid }, isError: true };
  }
  let before: string[];
  try {
    before = await getDesignatedAdminMemberIds(cred.orgId);
  } catch {
    return { kind: "result", data: { ok: false, code: "designated_admins_unavailable", message: "指定管理者の設定を読めませんでした。" }, isError: true };
  }
  const after = await describeMembers(cred.orgId, validation.memberIds);
  const lines = after.map((m) => `  - ${m.displayName || "(名前なし)"}（${m.memberId}）`);
  return {
    kind: "queue",
    title: "指定管理者の変更（オーナー承認が必要）",
    queuedArgs: { memberIds: validation.memberIds, beforeMemberIds: before },
    summary: [
      "承認者や権限を変える変更を承認できる「指定管理者」の一覧を変更します。",
      "この変更はオーナーだけが承認できます。",
      "",
      `■ 変更前: ${before.length} 人`,
      `■ 変更後: ${validation.memberIds.length} 人`,
      ...lines,
    ].join("\n"),
  };
}

export type DesignatedAdminsFulfillResult =
  | { ok: true; memberIds: string[]; summaryJa: string }
  | { ok: false; code: string; messageJa: string };

export async function fulfillDesignatedAdminsSet(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<DesignatedAdminsFulfillResult> {
  const orgId = approval.orgId;
  const stop = async (code: string, messageJa: string): Promise<DesignatedAdminsFulfillResult> => {
    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `指定管理者の変更を中止（${code}）`,
      metadata: { auditClass: ADMIN_AUDIT_CLASS, event: "org.designated_admins.rejected", tool: DESIGNATED_ADMINS_SET_TOOL, approvalId: approval.id, code },
    }).catch(() => undefined);
    return { ok: false, code, messageJa };
  };
  if (!isApproverAuthorityEnabled()) return stop("feature_disabled", FLAG_OFF.message);
  const approver = getVerifiedApprover(approval);
  if (!approver || approver.role !== "owner") {
    return stop("owner_approval_required", "指定管理者の一覧を変えられるのはオーナーだけです。オーナーの承認がありません。");
  }
  const validation = await validateDesignatedAdminIds(orgId, args.memberIds);
  if (!validation.ok) return stop(validation.code, validation.messageJa);
  let before: string[];
  try {
    before = await getDesignatedAdminMemberIds(orgId);
  } catch {
    return stop("designated_admins_unavailable", "指定管理者の設定を読めませんでした。");
  }
  await writeDesignatedAdminMemberIds(orgId, validation.memberIds);
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `指定管理者を変更（${before.length} 人 → ${validation.memberIds.length} 人・オーナー承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      event: "org.designated_admins.updated",
      tool: DESIGNATED_ADMINS_SET_TOOL,
      approvalId: approval.id,
      approverMemberId: approver.memberId,
      before,
      after: validation.memberIds,
    },
  });
  return {
    ok: true,
    memberIds: validation.memberIds,
    summaryJa: `指定管理者を ${validation.memberIds.length} 人に変更しました。`,
  };
}
