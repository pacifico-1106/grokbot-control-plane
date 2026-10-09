/**
 * PR-D: approver verification (approval time + right before fulfil).
 *
 * Production asks Postgres (public.approver_authority_check, the same function
 * resolve_approval_w1_checked uses) so the decision reads org_members and
 * orgs.designated_admin_member_ids in one place. Demo uses the TS mirror.
 * Any read failure → deny "approver_unverified" (fail closed).
 */
import type { ApprovalRequest } from "@/lib/types";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isApproverAuthorityEnabled } from "@/lib/feature-flags";
import { getRuntimeMembers } from "@/lib/demo-data";
import { isUuid } from "@/lib/data/members";
import { demoUpdateApproval } from "@/lib/data/demo-approvals-store";
import { getDesignatedAdminMemberIds } from "./designated-admins";
import {
  decideApproverAuthority,
  requesterMemberIdsFromMetadata,
  type ApproverAuthorityDecision,
  type ApproverAuthorityDenyReason,
  type ApproverAuthorityRole,
} from "./decide";
import { isApproverAuthorityTargetTool, isRequiredApproverKind, MAX_IMPLEMENTED_REQUIRED_APPROVALS, type RequiredApproverKind } from "./targets";

export interface ApproverAuthorityCheckInput {
  orgId: string;
  memberId: string | null | undefined;
  requiredKind: RequiredApproverKind | string | null | undefined;
  /** requesterMemberIdsFromMetadata(ticket.metadata); omitted = none. */
  requesterMemberIds?: readonly string[];
}

const DENY_REASONS = new Set<ApproverAuthorityDenyReason>([
  "invalid_required_kind",
  "org_has_no_owner",
  "approver_member_required",
  "approver_not_found",
  "approver_inactive",
  "approver_not_authorized",
  "approver_unverified",
  "no_owner_other_than_requester",
  "approver_is_requester",
]);

function parseDecision(raw: unknown): ApproverAuthorityDecision {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const role = value.approver_role;
  if (value.outcome === "allow" && (role === "owner" || role === "designated_admin")) {
    return { outcome: "allow", approverRole: role };
  }
  if (value.outcome === "endorse" && role === "designated_admin") {
    return { outcome: "endorse", approverRole: "designated_admin", reason: "owner_approval_required" };
  }
  const reason = value.reason as ApproverAuthorityDenyReason;
  return { outcome: "deny", reason: DENY_REASONS.has(reason) ? reason : "approver_unverified" };
}

async function demoDecision(input: ApproverAuthorityCheckInput): Promise<ApproverAuthorityDecision> {
  const members = getRuntimeMembers().filter((m) => m.orgId === input.orgId);
  const designated = await getDesignatedAdminMemberIds(input.orgId);
  const memberId = (input.memberId || "").trim() || null;
  const member = memberId ? members.find((m) => m.id === memberId) ?? null : null;
  const requesters = new Set(input.requesterMemberIds ?? []);
  const owners = members.filter((m) => m.role === "owner" && m.status === "active");
  return decideApproverAuthority(input.requiredKind, {
    memberId,
    member: member ? { role: member.role, status: member.status } : null,
    isDesignatedAdmin: Boolean(memberId && designated.includes(memberId)),
    activeOwnerCount: owners.length,
    eligibleOwnerCount: owners.filter((m) => !requesters.has(m.id)).length,
    eligibleDesignatedAdminCount: members.filter(
      (m) => m.role === "admin" && m.status === "active" && designated.includes(m.id) && !requesters.has(m.id)
    ).length,
    approverIsRequester: Boolean(memberId && requesters.has(memberId)),
  });
}

/** Decide whether memberId may approve a ticket that needs requiredKind. Never throws. */
export async function checkApproverAuthority(input: ApproverAuthorityCheckInput): Promise<ApproverAuthorityDecision> {
  if (!isRequiredApproverKind(input.requiredKind)) return { outcome: "deny", reason: "invalid_required_kind" };
  try {
    if (isDemoMode()) return await demoDecision(input);
    const admin = createSupabaseAdminClient();
    if (!admin) return { outcome: "deny", reason: "approver_unverified" };
    const memberId = (input.memberId || "").trim();
    const { data, error } = await admin.rpc("approver_authority_check", {
      p_org: input.orgId,
      // A non-uuid id cannot be a member; the RPC still answers org_has_no_owner first.
      p_member_id: isUuid(memberId) ? memberId : null,
      p_required_kind: input.requiredKind,
      p_requester_ids: [...(input.requesterMemberIds ?? [])],
    });
    if (error) return { outcome: "deny", reason: "approver_unverified" };
    const decision = parseDecision(data);
    if (memberId && !isUuid(memberId) && decision.outcome === "deny" && decision.reason === "approver_member_required") {
      return { outcome: "deny", reason: "approver_not_found" };
    }
    return decision;
  } catch {
    return { outcome: "deny", reason: "approver_unverified" };
  }
}

export type RecordApproverResult = { ok: true } | { ok: false; reason: string };

/**
 * Store the verified approver (mode "verified") or a designated-admin
 * endorsement (mode "endorse") on the ticket. Production re-checks inside the
 * RPC under a row lock; "verified" requires status approved, "endorse" pending.
 */
export async function recordApproverAuthority(
  approval: ApprovalRequest,
  memberId: string,
  mode: "verified" | "endorse"
): Promise<RecordApproverResult> {
  const kind = approval.requiredApproverKind;
  if (!isRequiredApproverKind(kind)) return { ok: false, reason: "invalid_required_kind" };
  try {
    if (isDemoMode()) {
      const decision = await demoDecision({
        orgId: approval.orgId,
        memberId,
        requiredKind: kind,
        requesterMemberIds: requesterMemberIdsFromMetadata(approval.metadata),
      });
      const expected = mode === "verified" ? "allow" : "endorse";
      if (decision.outcome !== expected) {
        return { ok: false, reason: decision.outcome === "deny" ? decision.reason : decision.outcome === "endorse" ? decision.reason : "approver_already_sufficient" };
      }
      const now = new Date().toISOString();
      const prior = approval.approverAuthority ?? {};
      const endorsements = Array.isArray(prior.endorsements) ? [...(prior.endorsements as unknown[])] : [];
      const patch: Partial<ApprovalRequest> =
        mode === "verified"
          ? {
              approverMemberId: memberId,
              approverRole: (decision as { approverRole: ApproverAuthorityRole }).approverRole,
              approverAuthority: { ...prior, verifiedAt: now, verifiedMemberId: memberId },
            }
          : {
              approverAuthority: {
                ...prior,
                endorsements: endorsements.some((e) => (e as { memberId?: string })?.memberId === memberId)
                  ? endorsements
                  : [...endorsements, { memberId, role: "designated_admin", at: now }],
              },
            };
      const updated = await demoUpdateApproval(approval.id, patch);
      if (!updated) return { ok: false, reason: "approval_not_found" };
      Object.assign(approval, patch);
      return { ok: true };
    }
    const admin = createSupabaseAdminClient();
    if (!admin) return { ok: false, reason: "approver_unverified" };
    const { data, error } = await admin.rpc("record_approver_authority", {
      p_id: approval.id,
      p_org: approval.orgId,
      p_member_id: isUuid(memberId) ? memberId : null,
      p_mode: mode,
    });
    if (error) return { ok: false, reason: "approver_unverified" };
    const result = (data ?? {}) as { ok?: boolean; reason?: string };
    return result.ok ? { ok: true } : { ok: false, reason: String(result.reason || "approver_unverified") };
  } catch {
    return { ok: false, reason: "approver_unverified" };
  }
}

/** Thrown right before fulfil; message = stable code (no secrets, no member details). */
export class ApproverAuthorityExecutionError extends Error {
  constructor(readonly reason: string) {
    super(reason.startsWith("approver_") ? reason : `approver_authority_${reason}`);
    this.name = "ApproverAuthorityExecutionError";
  }
}

/**
 * Re-verify the stored approver right before fulfil (called from
 * assertApprovalExecutionAuthority, before the demo early return).
 * Flag OFF or ticket without a required kind → no-op (today's behaviour).
 */
export async function assertApproverAuthorityForExecution(approval: ApprovalRequest): Promise<void> {
  if (!isApproverAuthorityEnabled()) return;
  const kind = approval.requiredApproverKind;
  if (kind === null || kind === undefined) {
    // Review 2026-10-09 item 4: a target-tool ticket with no class was filed
    // before ON (or its class was lost). It must not run on the old rules.
    if (isApproverAuthorityTargetTool(approval.tool)) throw new ApproverAuthorityExecutionError("approver_class_missing");
    return;
  }
  if (!isRequiredApproverKind(kind)) throw new ApproverAuthorityExecutionError("invalid_required_kind");
  const recordedCount = approval.approverAuthority?.requiredApprovals;
  if (recordedCount !== undefined && recordedCount !== null) {
    const n = Number(recordedCount);
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMPLEMENTED_REQUIRED_APPROVALS) {
      throw new ApproverAuthorityExecutionError("required_approvals_unsupported");
    }
  }
  const memberId = (approval.approverMemberId || "").trim();
  if (!memberId) throw new ApproverAuthorityExecutionError("approver_unverified");
  const decision = await checkApproverAuthority({
    orgId: approval.orgId,
    memberId,
    requiredKind: kind,
    requesterMemberIds: requesterMemberIdsFromMetadata(approval.metadata),
  });
  if (decision.outcome === "endorse") throw new ApproverAuthorityExecutionError("owner_approval_required");
  if (decision.outcome === "deny") throw new ApproverAuthorityExecutionError(decision.reason);
}

export type ApproverIdentityResult =
  | { ok: true; memberId: string | null }
  | { ok: false; reason: "approver_identity_unverified" };

/**
 * 確定仕様: the Slack / LINE / Telegram user who pressed must be linked to the
 * member who counts as the approver. With an externalVoter the member id is
 * (re)derived here from a verified, unexpired, unrevoked voter binding of this
 * org; a missing / unreadable binding or a different caller-supplied member id
 * → approver_identity_unverified (fail closed). Without an externalVoter (web)
 * the member id comes from the authenticated session.
 */
export async function verifyApproverIdentity(
  orgId: string,
  input: {
    memberId?: string | null;
    voterUserId?: string | null;
    externalVoter?: { provider: "slack" | "telegram" | "line"; channelKey: string; userId: string } | null;
  }
): Promise<ApproverIdentityResult> {
  const claimed = (input.memberId || "").trim() || null;
  if (!input.externalVoter) return { ok: true, memberId: claimed || (input.voterUserId || "").trim() || null };
  try {
    const { getMemberIdFromVoterBinding } = await import("@/lib/approval-workflow/data");
    const bound = ((await getMemberIdFromVoterBinding(orgId, input.externalVoter)) || "").trim();
    if (!bound) return { ok: false, reason: "approver_identity_unverified" };
    if (claimed && claimed !== bound) return { ok: false, reason: "approver_identity_unverified" };
    return { ok: true, memberId: bound };
  } catch {
    return { ok: false, reason: "approver_identity_unverified" };
  }
}
