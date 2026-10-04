/**
 * Pure guard for every human-member capability / role change.
 * Fixtures only (no tenant data). See lib/team/member-change-guard.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  MEMBER_CHANGE_DENY_MESSAGES_JA,
  PRIVILEGED_CAPABILITIES,
  SYSTEM_BOOTSTRAP_ACTOR,
  evaluateMemberChange,
  memberChangeEditability,
  type MemberChangeActor,
  type MemberSnapshot,
} from "./member-change-guard";

const ORG = "org-fixture-a";
const ALL = [
  "view_dashboard",
  "view_employees",
  "view_audit",
  "approve_actions",
  "manage_spend_limits",
  "hire_issue_credentials",
  "manage_team",
  "manage_billing",
];

type MemberActor = Extract<MemberChangeActor, { kind: "member" }>;
function actor(over: Partial<MemberActor> = {}): MemberActor {
  return {
    kind: "member",
    id: "m-admin",
    userId: "u-admin",
    orgId: ORG,
    role: "admin",
    capabilities: ["view_dashboard", "manage_team"],
    status: "active",
    emails: ["admin@fixture.invalid"],
    ...over,
  };
}
const owner = (over: Partial<Extract<MemberChangeActor, { kind: "member" }>> = {}) =>
  actor({ id: "m-owner", userId: "u-owner", role: "owner", capabilities: [...ALL], emails: ["owner@fixture.invalid"], ...over });

function snap(over: Partial<MemberSnapshot> = {}): MemberSnapshot {
  return {
    id: "m-target",
    userId: "u-target",
    orgId: ORG,
    email: "target@fixture.invalid",
    role: "member",
    capabilities: ["view_dashboard"],
    status: "active",
    ...over,
  };
}
const selfSnapOf = (a: MemberChangeActor) => {
  if (a.kind !== "member") throw new Error("member actor only");
  return snap({ id: a.id, userId: a.userId ?? null, email: String(a.emails[0]), role: a.role, capabilities: [...a.capabilities] });
};
const after = (before: MemberSnapshot | null, patch: { role?: string; capabilities?: string[]; email?: string; orgId?: string }) => ({
  orgId: patch.orgId ?? before?.orgId ?? ORG,
  email: patch.email ?? before?.email ?? "new@fixture.invalid",
  role: patch.role ?? before?.role ?? "member",
  capabilities: patch.capabilities ?? [...(before?.capabilities ?? [])],
});
const deny = (r: ReturnType<typeof evaluateMemberChange>) => (r.ok ? "ALLOWED" : r.code);

describe("privileged capabilities are owner-only (grant AND revoke)", () => {
  test("privileged set is exactly approve_actions / manage_billing / manage_spend_limits", () => {
    expect([...PRIVILEGED_CAPABILITIES].sort()).toEqual(["approve_actions", "manage_billing", "manage_spend_limits"]);
  });

  for (const cap of ["approve_actions", "manage_billing", "manage_spend_limits"]) {
    test(`admin cannot grant ${cap} to another member`, () => {
      const before = snap();
      const r = evaluateMemberChange({ actor: actor(), before, after: after(before, { capabilities: ["view_dashboard", cap] }), ownerCount: 1 });
      expect(deny(r)).toBe("owner_required_for_privileged_capability");
    });
    test(`admin cannot revoke ${cap} from another member`, () => {
      const before = snap({ capabilities: ["view_dashboard", cap] });
      const r = evaluateMemberChange({ actor: actor(), before, after: after(before, { capabilities: ["view_dashboard"] }), ownerCount: 1 });
      expect(deny(r)).toBe("owner_required_for_privileged_capability");
    });
    test(`owner can grant and revoke ${cap} on another member`, () => {
      const before = snap();
      const grant = evaluateMemberChange({ actor: owner(), before, after: after(before, { capabilities: ["view_dashboard", cap] }), ownerCount: 1 });
      expect(grant.ok).toBe(true);
      const held = snap({ capabilities: ["view_dashboard", cap] });
      const revoke = evaluateMemberChange({ actor: owner(), before: held, after: after(held, { capabilities: ["view_dashboard"] }), ownerCount: 1 });
      expect(revoke.ok).toBe(true);
    });
  }

  test("admin may still grant non-privileged capabilities to others (unchanged behaviour)", () => {
    const before = snap();
    const r = evaluateMemberChange({ actor: actor(), before, after: after(before, { capabilities: ["view_dashboard", "view_audit", "hire_issue_credentials"] }), ownerCount: 1 });
    expect(r.ok).toBe(true);
  });

  test("admin editing an unrelated field keeps an existing privileged capability (no diff → allowed)", () => {
    const before = snap({ capabilities: ["view_dashboard", "approve_actions"] });
    const r = evaluateMemberChange({ actor: actor(), before, after: after(before, { capabilities: ["approve_actions", "view_dashboard", "view_dashboard"] }), ownerCount: 1 });
    expect(r.ok).toBe(true);
  });
});

describe("owner role is owner-only", () => {
  test("admin cannot promote another member to owner", () => {
    const before = snap();
    expect(deny(evaluateMemberChange({ actor: actor(), before, after: after(before, { role: "owner" }), ownerCount: 1 }))).toBe("owner_required_for_owner_role");
  });
  test("admin cannot touch an owner's role/capabilities/email", () => {
    const before = snap({ role: "owner", capabilities: [...ALL] });
    for (const patch of [
      { role: "admin" },
      { capabilities: ALL.filter((c) => c !== "view_audit") },
      { email: "elsewhere@fixture.invalid" },
    ]) {
      expect(deny(evaluateMemberChange({ actor: actor(), before, after: after(before, patch), ownerCount: 2 }))).toBe("owner_target_requires_owner");
    }
  });
  test("owner can promote another member to owner and demote another owner when 2+ owners", () => {
    const before = snap();
    expect(evaluateMemberChange({ actor: owner(), before, after: after(before, { role: "owner" }), ownerCount: 1 }).ok).toBe(true);
    const other = snap({ role: "owner", capabilities: [...ALL] });
    expect(evaluateMemberChange({ actor: owner(), before: other, after: after(other, { role: "admin" }), ownerCount: 2 }).ok).toBe(true);
  });
});

describe("self escalation is denied for everyone (owner included); self demotion allowed", () => {
  test("admin adds approve_actions to self (the reported hole)", () => {
    const a = actor();
    const before = selfSnapOf(a);
    expect(deny(evaluateMemberChange({ actor: a, before, after: after(before, { capabilities: [...a.capabilities, "approve_actions"] }), ownerCount: 1 }))).toBe("self_escalation_forbidden");
  });
  test("admin adds even a view capability to self", () => {
    const a = actor();
    const before = selfSnapOf(a);
    expect(deny(evaluateMemberChange({ actor: a, before, after: after(before, { capabilities: [...a.capabilities, "view_audit"] }), ownerCount: 1 }))).toBe("self_escalation_forbidden");
  });
  test("admin promotes self to owner", () => {
    const a = actor();
    const before = selfSnapOf(a);
    expect(deny(evaluateMemberChange({ actor: a, before, after: after(before, { role: "owner" }), ownerCount: 1 }))).toBe("self_escalation_forbidden");
  });
  test("member with manage_team promotes self to admin", () => {
    const a = actor({ role: "member" });
    const before = selfSnapOf(a);
    expect(deny(evaluateMemberChange({ actor: a, before, after: after(before, { role: "admin" }), ownerCount: 1 }))).toBe("self_escalation_forbidden");
  });
  test("owner lacking manage_billing cannot add it to self", () => {
    const a = owner({ capabilities: ALL.filter((c) => c !== "manage_billing") });
    const before = selfSnapOf(a);
    expect(deny(evaluateMemberChange({ actor: a, before, after: after(before, { capabilities: [...ALL] }), ownerCount: 2 }))).toBe("self_escalation_forbidden");
  });
  test("self is matched by user id even when the member id differs (second row for the same Auth user)", () => {
    const a = actor();
    const before = snap({ id: "m-other-row", userId: "u-admin", email: "alias@fixture.invalid" });
    expect(deny(evaluateMemberChange({ actor: a, before, after: after(before, { capabilities: ["view_dashboard", "view_audit"] }), ownerCount: 1 }))).toBe("self_escalation_forbidden");
  });
  test("self is matched by email case-insensitively and across the actor's emails (profile + auth)", () => {
    const a = actor({ emails: ["admin@fixture.invalid", "Admin.Auth@Fixture.invalid"] });
    const rowWithUpper = snap({ id: "m-dup", userId: null, email: "ADMIN@FIXTURE.INVALID" });
    expect(deny(evaluateMemberChange({ actor: a, before: rowWithUpper, after: after(rowWithUpper, { capabilities: ["view_dashboard", "view_audit"] }), ownerCount: 1 }))).toBe("self_escalation_forbidden");
    expect(deny(evaluateMemberChange({ actor: a, before: null, after: after(null, { email: " admin.auth@fixture.INVALID ", capabilities: ["view_dashboard"] }), ownerCount: 1 }))).toBe("self_escalation_forbidden");
  });
  test("re-pointing another member's email to the actor's own email counts as self", () => {
    const a = actor();
    const before = snap();
    expect(deny(evaluateMemberChange({ actor: a, before, after: after(before, { email: "ADMIN@fixture.invalid", capabilities: ["view_dashboard", "view_audit"] }), ownerCount: 1 }))).toBe("self_escalation_forbidden");
  });
  test("owner can lower own capabilities", () => {
    const a = owner();
    const before = selfSnapOf(a);
    expect(evaluateMemberChange({ actor: a, before, after: after(before, { capabilities: ALL.filter((c) => c !== "manage_billing") }), ownerCount: 1 }).ok).toBe(true);
  });
  test("owner can step down from owner when another active owner exists", () => {
    const a = owner();
    const before = selfSnapOf(a);
    expect(evaluateMemberChange({ actor: a, before, after: after(before, { role: "admin" }), ownerCount: 2 }).ok).toBe(true);
  });
  test("admin can lower own non-privileged capability", () => {
    const a = actor({ capabilities: ["view_dashboard", "view_audit", "manage_team"] });
    const before = selfSnapOf(a);
    expect(evaluateMemberChange({ actor: a, before, after: after(before, { capabilities: ["view_dashboard", "manage_team"] }), ownerCount: 1 }).ok).toBe(true);
  });
});

describe("last owner", () => {
  test("cannot demote the last active owner (other owner acting is impossible, so self case)", () => {
    const a = owner();
    const before = selfSnapOf(a);
    expect(deny(evaluateMemberChange({ actor: a, before, after: after(before, { role: "admin" }), ownerCount: 1 }))).toBe("last_owner_required");
  });
  test("ownerCount 0 (inconsistent data) still blocks removing an active owner", () => {
    const before = snap({ role: "owner", capabilities: [...ALL] });
    expect(deny(evaluateMemberChange({ actor: owner(), before, after: after(before, { role: "member" }), ownerCount: 0 }))).toBe("last_owner_required");
  });
  test("an invited (not yet active) owner can be demoted while one active owner remains", () => {
    const before = snap({ role: "owner", status: "invited", capabilities: [...ALL] });
    expect(evaluateMemberChange({ actor: owner(), before, after: after(before, { role: "admin" }), ownerCount: 1 }).ok).toBe(true);
  });
});

describe("invite (new member) uses the same rules", () => {
  test("admin cannot invite with approve_actions", () => {
    expect(deny(evaluateMemberChange({ actor: actor(), before: null, after: after(null, { capabilities: ["view_dashboard", "approve_actions"] }), ownerCount: 1 }))).toBe("owner_required_for_privileged_capability");
  });
  test("admin cannot invite as owner", () => {
    expect(deny(evaluateMemberChange({ actor: actor(), before: null, after: after(null, { role: "owner", capabilities: ["view_dashboard"] }), ownerCount: 1 }))).toBe("owner_required_for_owner_role");
  });
  test("admin can invite a view-only member", () => {
    expect(evaluateMemberChange({ actor: actor(), before: null, after: after(null, { capabilities: ["view_dashboard"] }), ownerCount: 1 }).ok).toBe(true);
  });
  test("owner can invite with privileged capabilities and as owner", () => {
    expect(evaluateMemberChange({ actor: owner(), before: null, after: after(null, { role: "owner", capabilities: [...ALL] }), ownerCount: 1 }).ok).toBe(true);
  });
});

describe("input validation and actor/org checks", () => {
  test("unknown capability value is rejected", () => {
    const before = snap();
    const r = evaluateMemberChange({ actor: owner(), before, after: after(before, { capabilities: ["view_dashboard", "super_admin"] }), ownerCount: 1 });
    expect(deny(r)).toBe("unknown_capability");
    const r2 = evaluateMemberChange({ actor: owner(), before, after: { ...after(before, {}), capabilities: ["view_dashboard", 42 as unknown as string] }, ownerCount: 1 });
    expect(deny(r2)).toBe("unknown_capability");
  });
  test("unknown role is rejected", () => {
    const before = snap();
    expect(deny(evaluateMemberChange({ actor: owner(), before, after: after(before, { role: "superowner" }), ownerCount: 1 }))).toBe("unknown_role");
  });
  test("target in another org is rejected", () => {
    const before = snap({ orgId: "org-fixture-b" });
    expect(deny(evaluateMemberChange({ actor: owner(), before, after: after(before, { orgId: "org-fixture-b" }), ownerCount: 1 }))).toBe("cross_org_target");
    const local = snap();
    expect(deny(evaluateMemberChange({ actor: owner(), before: local, after: after(local, { orgId: "org-fixture-b" }), ownerCount: 1 }))).toBe("cross_org_target");
  });
  test("inactive actor is rejected", () => {
    const before = snap();
    expect(deny(evaluateMemberChange({ actor: owner({ status: "disabled" }), before, after: after(before, { capabilities: ["view_dashboard", "view_audit"] }), ownerCount: 2 }))).toBe("actor_not_active_member");
  });
  test("actor without manage_team is rejected", () => {
    const before = snap();
    expect(deny(evaluateMemberChange({ actor: actor({ capabilities: ["view_dashboard"] }), before, after: after(before, { capabilities: ["view_dashboard", "view_audit"] }), ownerCount: 1 }))).toBe("manage_team_required");
  });
  test("every deny code has a Japanese message", () => {
    for (const [code, msg] of Object.entries(MEMBER_CHANGE_DENY_MESSAGES_JA)) {
      expect(code).toMatch(/^[a-z_]+$/);
      expect(msg).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    }
    const r = evaluateMemberChange({ actor: actor(), before: null, after: after(null, { role: "owner" }), ownerCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.messageJa).toBe(MEMBER_CHANGE_DENY_MESSAGES_JA[r.code]);
  });
  test("allowed decisions report the diff for the audit log", () => {
    const before = snap({ capabilities: ["view_dashboard", "view_audit"] });
    const r = evaluateMemberChange({ actor: owner(), before, after: after(before, { role: "admin", capabilities: ["view_dashboard", "approve_actions"] }), ownerCount: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.added).toEqual(["approve_actions"]);
      expect(r.removed).toEqual(["view_audit"]);
      expect(r.roleBefore).toBe("member");
      expect(r.roleAfter).toBe("admin");
      expect(r.capabilitiesAfter).toEqual(["view_dashboard", "approve_actions"]);
    }
  });
});

describe("system bootstrap (org provisioning) goes through the same function", () => {
  test("first owner of a brand-new org is allowed", () => {
    expect(evaluateMemberChange({ actor: SYSTEM_BOOTSTRAP_ACTOR(ORG), before: null, after: after(null, { role: "owner", capabilities: [...ALL] }), ownerCount: 0 }).ok).toBe(true);
  });
  test("bootstrap is refused once an owner exists, or against an existing row", () => {
    expect(deny(evaluateMemberChange({ actor: SYSTEM_BOOTSTRAP_ACTOR(ORG), before: null, after: after(null, { role: "owner", capabilities: [...ALL] }), ownerCount: 1 }))).toBe("bootstrap_not_allowed");
    const before = snap();
    expect(deny(evaluateMemberChange({ actor: SYSTEM_BOOTSTRAP_ACTOR(ORG), before, after: after(before, { role: "owner" }), ownerCount: 0 }))).toBe("bootstrap_not_allowed");
  });
});

describe("UI editability is derived from the same guard", () => {
  test("admin editing another member: privileged boxes and owner role disabled", () => {
    const e = memberChangeEditability({ actor: actor(), before: snap(), ownerCount: 1 });
    expect(e.capabilities.approve_actions).toBe(false);
    expect(e.capabilities.manage_billing).toBe(false);
    expect(e.capabilities.manage_spend_limits).toBe(false);
    expect(e.capabilities.view_audit).toBe(true);
    expect(e.roles.owner).toBe(false);
    expect(e.roles.admin).toBe(true);
  });
  test("admin editing self: cannot add anything, can remove what they hold (non-privileged)", () => {
    const a = actor({ capabilities: ["view_dashboard", "manage_team"] });
    const e = memberChangeEditability({ actor: a, before: selfSnapOf(a), ownerCount: 1 });
    expect(e.capabilities.view_audit).toBe(false);
    expect(e.capabilities.view_dashboard).toBe(true);
    expect(e.roles.owner).toBe(false);
    expect(e.roles.member).toBe(true);
  });
  test("owner inviting: everything enabled", () => {
    const e = memberChangeEditability({ actor: owner(), before: null, ownerCount: 1 });
    expect(Object.values(e.capabilities).every(Boolean)).toBe(true);
    expect(Object.values(e.roles).every(Boolean)).toBe(true);
  });
  test("last owner editing self: owner role is the only enabled role", () => {
    const a = owner();
    const e = memberChangeEditability({ actor: a, before: selfSnapOf(a), ownerCount: 1 });
    expect(e.roles).toEqual({ owner: true, admin: false, member: false });
  });
});
