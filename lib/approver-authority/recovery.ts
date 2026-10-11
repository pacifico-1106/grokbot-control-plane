/**
 * Review 2026-10-09 item 5 (F8 recovery). recordApproverAuthority can fail
 * after the ticket is already approved (only the final-approver write fails).
 * Such a ticket is approved, has a required approver class, has no recorded
 * approver and has not been fulfilled — fulfil refuses it forever
 * (approver_unverified), so it can never run and never be re-decided.
 *
 * Recovery: an active OWNER of that org (dashboard session) or the platform
 * operator (super-admin session) may revoke it → status "rejected" + an audit
 * row with IDs only. The requester then files again. Nothing else is
 * revocable here: the update is conditional on that exact state.
 */
import type { ApprovalRequest } from "@/lib/types";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { appendAuditEvent } from "@/lib/data/audit";
import { getApprovalById } from "@/lib/data/approvals";
import { mapApprovalRow } from "@/lib/data/mappers";
import { demoGetApproval, demoUpdateApproval } from "@/lib/data/demo-approvals-store";
import { parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { checkApproverAuthorityDetailed } from "./verify";
import { isRequiredApproverKind } from "./targets";

export type RevokeUnrecordedActor =
  | { kind: "owner"; memberId: string }
  | { kind: "operator"; email: string };

export type RevokeUnrecordedResult =
  | { ok: true; approval: ApprovalRequest }
  | {
      ok: false;
      code: "approval_not_found" | "not_recoverable" | "actor_not_owner" | "revoke_failed" | "approver_authority_unavailable";
    };

/** approved + required class + no recorded approver + never fulfilled. */
export function isUnrecordedApprovedTicket(approval: ApprovalRequest): boolean {
  if (approval.status !== "approved") return false;
  if (!isRequiredApproverKind(approval.requiredApproverKind)) return false;
  if ((approval.approverMemberId || "").trim()) return false;
  const metadata = (approval.metadata ?? {}) as Record<string, unknown>;
  if (parseAdminFulfillment(metadata) || metadata.adminFulfillment || metadata.fulfillment) return false;
  return true;
}

export async function revokeUnrecordedApproval(input: {
  orgId: string;
  approvalId: string;
  actor: RevokeUnrecordedActor;
}): Promise<RevokeUnrecordedResult> {
  const orgId = (input.orgId || "").trim();
  const approvalId = (input.approvalId || "").trim();
  if (!orgId || !approvalId) return { ok: false, code: "approval_not_found" };
  const approval = await getApprovalById(approvalId, orgId);
  if (!approval || approval.orgId !== orgId) return { ok: false, code: "approval_not_found" };

  if (input.actor.kind === "owner") {
    const memberId = (input.actor.memberId || "").trim();
    const checked = memberId
      ? await checkApproverAuthorityDetailed({ orgId, memberId, requiredKind: "owner", requesterMemberIds: [] })
      : null;
    // 2026-10-10 item 2(b): before migration 20261005500000 the owner check
    // RPC does not exist. Say so instead of "not an owner"; nothing is written.
    // Not gated on the flag: after a flag rollback the RPC exists and the
    // recovery must still work.
    if (checked?.rpcMissing) return { ok: false, code: "approver_authority_unavailable" };
    if (!checked || checked.decision.outcome !== "allow") return { ok: false, code: "actor_not_owner" };
  }
  if (!isUnrecordedApprovedTicket(approval)) return { ok: false, code: "not_recoverable" };

  const at = new Date().toISOString();
  const revoked = { at, by: input.actor.kind, reason: "approver_record_missing" };
  let updated: ApprovalRequest | null = null;
  if (isDemoMode()) {
    const current = await demoGetApproval(approvalId);
    if (!current || current.orgId !== orgId || !isUnrecordedApprovedTicket(current)) return { ok: false, code: "not_recoverable" };
    updated = await demoUpdateApproval(approvalId, {
      status: "rejected",
      resolvedAt: at,
      metadata: { ...current.metadata, unrecordedApprovalRevoked: revoked },
    });
  } else {
    const admin = createSupabaseAdminClient();
    if (!admin) return { ok: false, code: "revoke_failed" };
    const { data, error } = await admin
      .from("approval_requests")
      .update({ status: "rejected", resolved_at: at })
      .eq("id", approvalId)
      .eq("org_id", orgId)
      .eq("status", "approved")
      .is("approver_member_id", null)
      .not("required_approver_kind", "is", null)
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, code: "revoke_failed" };
    if (!data) return { ok: false, code: "not_recoverable" };
    updated = mapApprovalRow(data as Record<string, unknown>);
    try {
      const merged = await admin.rpc("merge_approval_metadata", {
        p_id: approvalId, p_org: orgId, p_patch: { unrecordedApprovalRevoked: revoked },
      });
      if (!merged.error && merged.data) updated = mapApprovalRow(merged.data as Record<string, unknown>);
    } catch {
      // Status is already rejected; the audit row carries the reason.
    }
  }
  if (!updated) return { ok: false, code: "revoke_failed" };

  await appendAuditEvent({
    orgId,
    employeeId: approval.employeeId ?? null,
    credentialId: null,
    action: "admin.policy",
    purpose: "approver_authority.unrecorded_revoked",
    summary: "承認者の記録がない承認済み申請を取り消し",
    metadata: {
      approvalId,
      tool: approval.tool ?? null,
      requiredApproverKind: approval.requiredApproverKind ?? null,
      revokedBy: input.actor.kind,
      actorMemberId: input.actor.kind === "owner" ? input.actor.memberId : null,
      operator: input.actor.kind === "operator",
    },
  }).catch(() => undefined);
  return { ok: true, approval: updated };
}

export const REVOKE_UNRECORDED_MESSAGES_JA: Record<Exclude<RevokeUnrecordedResult, { ok: true }>["code"], string> = {
  approval_not_found: "申請が見つかりません。",
  not_recoverable: "この申請は取り消しの対象ではありません（承認済みで承認者の記録がなく、未実行の申請だけが対象です）。",
  actor_not_owner: "この取り消しはその組織のオーナーだけが行えます。",
  revoke_failed: "取り消しに失敗しました。時間をおいて再度お試しください。",
  approver_authority_unavailable:
    "この環境には承認者の権限チェック（migration 20261005500000）がまだ入っていないため、この取り消しは使えません。",
};

/** What to do next, for codes where the caller can act (shown with the message). */
export const REVOKE_UNRECORDED_NEXT_STEP_JA: Partial<Record<Exclude<RevokeUnrecordedResult, { ok: true }>["code"], string>> = {
  approver_authority_unavailable:
    "この取り消しが必要になる申請は、migration 20261005500000 を入れるまで作られないので、今は対応は要りません。入れたあとで必要なら、もう一度お試しください。",
};

/** HTTP status for the revoke routes. */
export function revokeUnrecordedHttpStatus(code: Exclude<RevokeUnrecordedResult, { ok: true }>["code"]): number {
  switch (code) {
    case "actor_not_owner":
      return 403;
    case "approval_not_found":
      return 404;
    case "not_recoverable":
      return 409;
    case "approver_authority_unavailable":
      return 503;
    default:
      return 500;
  }
}
