/** PR-D: decision table — same cases as tests/security/db-approver-authority.sql (SQL mirror). */
import { expect, test } from "bun:test";
import {
  decideApproverAuthority,
  requesterMemberIdsFromMetadata,
  type ApproverAuthorityDecision,
  type ApproverFacts,
} from "@/lib/approver-authority/decide";

const owner = { role: "owner", status: "active" };
const admin = { role: "admin", status: "active" };
const facts = (over: Partial<ApproverFacts>): ApproverFacts => ({ memberId: "m", member: admin, isDesignatedAdmin: false, activeOwnerCount: 1, ...over });

const CASES: Array<[string, string, ApproverFacts, ApproverAuthorityDecision]> = [
  ["owner, standard", "owner_or_designated_admin", facts({ member: owner }), { outcome: "allow", approverRole: "owner" }],
  ["owner, sensitive", "owner", facts({ member: owner }), { outcome: "allow", approverRole: "owner" }],
  ["designated admin, standard", "owner_or_designated_admin", facts({ isDesignatedAdmin: true }), { outcome: "allow", approverRole: "designated_admin" }],
  ["designated admin, sensitive → endorse", "owner", facts({ isDesignatedAdmin: true }), { outcome: "endorse", approverRole: "designated_admin", reason: "owner_approval_required" }],
  ["admin not designated", "owner_or_designated_admin", facts({}), { outcome: "deny", reason: "approver_not_authorized" }],
  ["member in the list (role not admin)", "owner_or_designated_admin", facts({ member: { role: "member", status: "active" }, isDesignatedAdmin: true }), { outcome: "deny", reason: "approver_not_authorized" }],
  ["disabled designated admin", "owner_or_designated_admin", facts({ member: { role: "admin", status: "disabled" }, isDesignatedAdmin: true }), { outcome: "deny", reason: "approver_inactive" }],
  ["unknown member", "owner_or_designated_admin", facts({ member: null }), { outcome: "deny", reason: "approver_not_found" }],
  ["no member id", "owner", facts({ memberId: null, member: null }), { outcome: "deny", reason: "approver_member_required" }],
  ["bad kind", "admin", facts({ member: owner }), { outcome: "deny", reason: "invalid_required_kind" }],
  ["zero owners (even for an owner-looking member)", "owner_or_designated_admin", facts({ member: owner, activeOwnerCount: 0 }), { outcome: "deny", reason: "org_has_no_owner" }],
  // Multiple owners (八坂 2026-10-05): any one owner other than the requester suffices.
  ["3 owners, requester is one: another owner approves", "owner", facts({ member: owner, activeOwnerCount: 3, eligibleOwnerCount: 2 }), { outcome: "allow", approverRole: "owner" }],
  ["3 owners: the requesting owner cannot approve", "owner", facts({ member: owner, activeOwnerCount: 3, eligibleOwnerCount: 2, approverIsRequester: true }), { outcome: "deny", reason: "approver_is_requester" }],
  ["2 owners, both requesters (owner kind) → stop", "owner", facts({ member: owner, activeOwnerCount: 2, eligibleOwnerCount: 0, eligibleDesignatedAdminCount: 3 }), { outcome: "deny", reason: "no_owner_other_than_requester" }],
  // 確定仕様 10:11: a sole owner's own approval counts (both kinds, one tap).
  ["sole owner approves own request (owner kind)", "owner", facts({ member: owner, activeOwnerCount: 1, eligibleOwnerCount: 0, approverIsRequester: true }), { outcome: "allow", approverRole: "owner" }],
  ["sole owner approves own request (standard)", "owner_or_designated_admin", facts({ member: owner, activeOwnerCount: 1, eligibleOwnerCount: 0, approverIsRequester: true }), { outcome: "allow", approverRole: "owner" }],
  ["sole owner as requester: designated admin still endorses only (owner kind)", "owner", facts({ isDesignatedAdmin: true, activeOwnerCount: 1, eligibleOwnerCount: 0 }), { outcome: "endorse", approverRole: "designated_admin", reason: "owner_approval_required" }],
  ["requesting designated admin cannot approve own standard request", "owner_or_designated_admin", facts({ isDesignatedAdmin: true, approverIsRequester: true, eligibleDesignatedAdminCount: 0 }), { outcome: "deny", reason: "approver_is_requester" }],
  ["every owner is the requester, no designated admin (standard) → stop", "owner_or_designated_admin", facts({ memberId: null, member: null, activeOwnerCount: 2, eligibleOwnerCount: 0, eligibleDesignatedAdminCount: 0 }), { outcome: "deny", reason: "no_owner_other_than_requester" }],
  ["owner is the requester but a designated admin can approve (standard)", "owner_or_designated_admin", facts({ isDesignatedAdmin: true, eligibleOwnerCount: 0, eligibleDesignatedAdminCount: 1 }), { outcome: "allow", approverRole: "designated_admin" }],
  ["zero owners is reported before the requester check", "owner", facts({ activeOwnerCount: 0, eligibleOwnerCount: 0 }), { outcome: "deny", reason: "org_has_no_owner" }],
];

for (const [label, kind, f, expected] of CASES) {
  test(label, () => {
    expect(decideApproverAuthority(kind, f)).toEqual(expected);
  });
}

test("requester member ids come from adminRequester.actorId and requesterMemberId", () => {
  expect(requesterMemberIdsFromMetadata(null)).toEqual([]);
  expect(requesterMemberIdsFromMetadata({ adminRequester: { kind: "admin_agent", actorId: " a1 " }, requesterMemberId: "m1" })).toEqual(["a1", "m1"]);
  expect(requesterMemberIdsFromMetadata({ adminRequester: "x", requesterMemberId: 5 })).toEqual([]);
  expect(requesterMemberIdsFromMetadata({ adminRequester: { actorId: "m1" }, requesterMemberId: "m1" })).toEqual(["m1"]);
});
