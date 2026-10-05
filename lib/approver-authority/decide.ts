/**
 * PR-D: pure approver-authority decision. Mirrors SQL
 * public.approver_authority_check (migration 20261005500000) so demo and
 * production decide identically; both are pinned by the same case table.
 */
import { isRequiredApproverKind, type RequiredApproverKind } from "./targets";

/** What the approver counted as on the ticket (approval_requests.approver_role). */
export type ApproverAuthorityRole = "owner" | "designated_admin";

export type ApproverAuthorityDenyReason =
  | "invalid_required_kind"
  | "org_has_no_owner"
  | "no_owner_other_than_requester"
  | "approver_member_required"
  | "approver_not_found"
  | "approver_inactive"
  | "approver_not_authorized"
  | "approver_is_requester"
  | "approver_unverified";

export type ApproverAuthorityDecision =
  | { outcome: "allow"; approverRole: ApproverAuthorityRole }
  /** Designated admin on an owner-required ticket: recorded, ticket stays pending. */
  | { outcome: "endorse"; approverRole: "designated_admin"; reason: "owner_approval_required" }
  | { outcome: "deny"; reason: ApproverAuthorityDenyReason };

export interface ApproverFacts {
  /** null = no member id was presented. */
  memberId: string | null;
  member: { role: string; status: string } | null;
  isDesignatedAdmin: boolean;
  activeOwnerCount: number;
  /**
   * Multiple owners (八坂 2026-10-05): any one owner other than the requester
   * suffices; a sole owner may approve their own request. Active owners whose
   * member id is not a requester id.
   * Omitted = activeOwnerCount (no requester member on the ticket).
   */
  eligibleOwnerCount?: number;
  /** Active role-admin designated admins who are not the requester (standard tickets). */
  eligibleDesignatedAdminCount?: number;
  /** The presented member is the requester of this ticket. */
  approverIsRequester?: boolean;
}

export function decideApproverAuthority(
  requiredKind: RequiredApproverKind | string | null | undefined,
  facts: ApproverFacts
): ApproverAuthorityDecision {
  if (!isRequiredApproverKind(requiredKind)) return { outcome: "deny", reason: "invalid_required_kind" };
  if (!(facts.activeOwnerCount >= 1)) return { outcome: "deny", reason: "org_has_no_owner" };
  // 確定仕様 (八坂 2026-10-05 10:11): a sole owner may approve their own request;
  // with several owners the requester's approval never counts. Only when several
  // owners exist and every one of them is a requester can nobody approve → stop.
  const soleOwner = facts.activeOwnerCount === 1;
  const eligibleOwners = facts.eligibleOwnerCount ?? facts.activeOwnerCount;
  const eligibleDesignated = facts.eligibleDesignatedAdminCount ?? 0;
  if (!soleOwner && !(eligibleOwners >= 1) && (requiredKind === "owner" || !(eligibleDesignated >= 1))) {
    return { outcome: "deny", reason: "no_owner_other_than_requester" };
  }
  if (!facts.memberId) return { outcome: "deny", reason: "approver_member_required" };
  if (!facts.member) return { outcome: "deny", reason: "approver_not_found" };
  if (facts.member.status !== "active") return { outcome: "deny", reason: "approver_inactive" };
  // Self-approval ban, member-id form (the actor-id ban in self-approval.ts still
  // runs first). Exception: the org's only owner approving their own request.
  if (facts.approverIsRequester && !(soleOwner && facts.member.role === "owner")) {
    return { outcome: "deny", reason: "approver_is_requester" };
  }
  if (facts.member.role === "owner") return { outcome: "allow", approverRole: "owner" };
  if (facts.isDesignatedAdmin && facts.member.role === "admin") {
    return requiredKind === "owner"
      ? { outcome: "endorse", approverRole: "designated_admin", reason: "owner_approval_required" }
      : { outcome: "allow", approverRole: "designated_admin" };
  }
  return { outcome: "deny", reason: "approver_not_authorized" };
}

/** Result reasons callers (Slack / LINE / Telegram / web) map to user feedback. */
export const APPROVER_AUTHORITY_RESULT_REASONS = [
  "owner_approval_required",
  "invalid_required_kind",
  "org_has_no_owner",
  "approver_member_required",
  "approver_not_found",
  "approver_inactive",
  "approver_not_authorized",
  "approver_unverified",
  "no_owner_other_than_requester",
  "approver_is_requester",
  "approver_identity_unverified",
  // members.promoteOwner: the member being promoted may not approve their own promotion.
  "approver_is_target",
] as const;

export type ApproverAuthorityResultReason = (typeof APPROVER_AUTHORITY_RESULT_REASONS)[number];

export function isApproverAuthorityResultReason(reason: unknown): reason is ApproverAuthorityResultReason {
  return typeof reason === "string" && (APPROVER_AUTHORITY_RESULT_REASONS as readonly string[]).includes(reason);
}

/**
 * Member ids that count as "the requester" of a ticket. Admin-MCP tickets carry
 * metadata.adminRequester.actorId (the admin agent id today; never an
 * org_members id, so it excludes nobody); human-filed tickets (PR-K / PR-L)
 * set metadata.requesterMemberId. Mirrors SQL approver_authority_requester_ids.
 */
export function requesterMemberIdsFromMetadata(metadata: Record<string, unknown> | null | undefined): string[] {
  const out = new Set<string>();
  const requester = metadata?.adminRequester;
  if (requester && typeof requester === "object" && !Array.isArray(requester)) {
    const actorId = (requester as Record<string, unknown>).actorId;
    if (typeof actorId === "string" && actorId.trim()) out.add(actorId.trim());
  }
  const member = metadata?.requesterMemberId;
  if (typeof member === "string" && member.trim()) out.add(member.trim());
  return [...out];
}

/**
 * members.promoteOwner (八坂 10:11): neither the requester nor the member being
 * promoted may approve — no sole-owner exception (the requester may never be
 * the approver here). Dependency-free; checked at approval time and again at
 * fulfil. Returns null when there is no conflict (or the ticket is another tool).
 */
export const PROMOTE_OWNER_TOOL_NAME = "members.promoteOwner";

export function promoteOwnerApproverConflict(
  approval: { tool?: string | null; metadata?: Record<string, unknown> | null },
  approverMemberId: string | null | undefined
): "approver_is_target" | "approver_is_requester" | null {
  if (approval.tool !== PROMOTE_OWNER_TOOL_NAME) return null;
  const approver = String(approverMemberId || "").trim();
  if (!approver) return null; // missing approver is refused elsewhere (fail closed)
  const mutation = approval.metadata?.adminMutation;
  const target = mutation && typeof mutation === "object" && !Array.isArray(mutation)
    ? String((mutation as Record<string, unknown>).memberId || "").trim()
    : "";
  if (target && approver === target) return "approver_is_target";
  if (requesterMemberIdsFromMetadata(approval.metadata).includes(approver)) return "approver_is_requester";
  return null;
}
