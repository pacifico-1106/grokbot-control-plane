/**
 * POST/GET /api/team/members — capability & role escalation guard (DEMO store).
 * Repro of the 2026-10-04 report: an admin with manage_team (no approve_actions)
 * could grant approve_actions to themselves. Fixture members only.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DEMO_ORG,
  getRuntimeAudit,
  getRuntimeMemberById,
  getRuntimeMembers,
  resetRuntimeMembers,
  setRuntimeMember,
} from "@/lib/demo-data";
import type { HumanCapability, OrgMember } from "@/lib/types";

mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/billing/entitlements", () => ({
  assertBillingAllows: async () => ({ ok: true, entitlements: {} }),
}));

const { GET, POST } = await import("./route");

const ALL: HumanCapability[] = [
  "view_dashboard", "view_employees", "view_audit", "approve_actions",
  "manage_spend_limits", "hire_issue_credentials", "manage_team", "manage_billing",
];

function member(id: string, over: Partial<OrgMember>): OrgMember {
  return {
    id, orgId: DEMO_ORG.id, email: `${id}@fixture.invalid`, displayName: id,
    role: "member", jobRole: "custom", jobLabel: null, capabilities: ["view_dashboard"],
    status: "active", ...over,
  };
}

beforeEach(() => {
  resetRuntimeMembers();
  // Owner = mem_1 (seed). Remove the seeded admin/member to control owner count + fixtures.
  getRuntimeMembers().splice(1);
  setRuntimeMember(member("fx_admin", { role: "admin", capabilities: ["view_dashboard", "view_employees", "manage_team"] }));
  setRuntimeMember(member("fx_target", { capabilities: ["view_dashboard", "approve_actions"] }));
  setRuntimeMember(member("fx_plain", { capabilities: ["view_dashboard"] }));
});

function post(actorId: string, body: Record<string, unknown>) {
  return POST(new Request("https://fixture.invalid/api/team/members", {
    method: "POST",
    headers: { "content-type": "application/json", "x-member-id": actorId },
    body: JSON.stringify(body),
  }));
}
function edit(actorId: string, target: OrgMember, patch: Partial<OrgMember>) {
  return post(actorId, {
    id: target.id, email: target.email, displayName: target.displayName,
    role: patch.role ?? target.role, jobRole: target.jobRole, jobLabel: target.jobLabel,
    capabilities: patch.capabilities ?? target.capabilities,
  });
}
const m = (id: string) => {
  const hit = getRuntimeMemberById(id);
  if (!hit) throw new Error(`fixture ${id} missing`);
  return { ...hit, capabilities: [...(hit.capabilities ?? [])] };
};
const deniedAudits = () => getRuntimeAudit().filter((a) => a.action === "member.change_denied");

async function expectDenied(res: Response, code: string, status = 403) {
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.code).toBe(code);
  expect(String(body.message)).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  return body;
}

describe("self escalation", () => {
  test("admin (manage_team, no approve_actions) cannot add approve_actions to self", async () => {
    const self = m("fx_admin");
    const before = deniedAudits().length;
    const res = await edit("fx_admin", self, { capabilities: [...self.capabilities!, "approve_actions"] });
    await expectDenied(res, "self_escalation_forbidden");
    expect(m("fx_admin").capabilities).not.toContain("approve_actions");
    const audits = deniedAudits();
    expect(audits.length).toBe(before + 1);
    expect(audits[0].metadata).toMatchObject({
      code: "self_escalation_forbidden",
      actorMemberId: "fx_admin",
      targetMemberId: "fx_admin",
      capabilitiesBefore: self.capabilities,
      roleBefore: "admin",
      roleRequested: "admin",
    });
    expect((audits[0].metadata as { capabilitiesRequested: string[] }).capabilitiesRequested).toContain("approve_actions");
  });

  test("admin cannot promote self to owner", async () => {
    await expectDenied(await edit("fx_admin", m("fx_admin"), { role: "owner" }), "self_escalation_forbidden");
    expect(m("fx_admin").role).toBe("admin");
  });

  test("owner cannot add a capability they lack to themselves", async () => {
    setRuntimeMember(member("fx_owner2", { role: "owner", capabilities: ALL.filter((c) => c !== "manage_billing") }));
    await expectDenied(await edit("fx_owner2", m("fx_owner2"), { capabilities: ALL }), "self_escalation_forbidden");
  });

  test("self via the same email in different case (no id) is still self", async () => {
    const res = await post("fx_admin", {
      email: "FX_ADMIN@Fixture.Invalid", displayName: "dup", role: "admin", jobRole: "custom",
      capabilities: ["view_dashboard", "view_employees", "manage_team", "approve_actions"],
    });
    await expectDenied(res, "self_escalation_forbidden");
    expect(getRuntimeMembers().filter((x) => x.email.toLowerCase() === "fx_admin@fixture.invalid").length).toBe(1);
    expect(m("fx_admin").capabilities).not.toContain("approve_actions");
  });
});

describe("privileged capabilities / owner role are owner-only", () => {
  test("admin cannot grant approve_actions to another member", async () => {
    const t = m("fx_plain");
    await expectDenied(await edit("fx_admin", t, { capabilities: ["view_dashboard", "approve_actions"] }), "owner_required_for_privileged_capability");
    expect(m("fx_plain").capabilities).toEqual(["view_dashboard"]);
  });

  test("admin cannot revoke approve_actions from another member", async () => {
    await expectDenied(await edit("fx_admin", m("fx_target"), { capabilities: ["view_dashboard"] }), "owner_required_for_privileged_capability");
    expect(m("fx_target").capabilities).toContain("approve_actions");
  });

  test("admin cannot promote another member to owner", async () => {
    await expectDenied(await edit("fx_admin", m("fx_plain"), { role: "owner" }), "owner_required_for_owner_role");
    expect(m("fx_plain").role).toBe("member");
  });

  test("owner grants approve_actions to another member; audit records before and after", async () => {
    const res = await edit("mem_1", m("fx_plain"), { capabilities: ["view_dashboard", "approve_actions"] });
    expect(res.status).toBe(200);
    expect(m("fx_plain").capabilities).toEqual(["view_dashboard", "approve_actions"]);
    const audit = getRuntimeAudit().find((a) => a.action === "member.updated" && (a.metadata as { memberId?: string }).memberId === "fx_plain");
    expect(audit?.metadata).toMatchObject({
      memberId: "fx_plain",
      actorMemberId: "mem_1",
      capabilitiesBefore: ["view_dashboard"],
      capabilitiesAfter: ["view_dashboard", "approve_actions"],
      added: ["approve_actions"],
      removed: [],
      roleBefore: "member",
      roleAfter: "member",
    });
  });

  test("owner revokes approve_actions and promotes another member to owner", async () => {
    expect((await edit("mem_1", m("fx_target"), { capabilities: ["view_dashboard"] })).status).toBe(200);
    expect(m("fx_target").capabilities).toEqual(["view_dashboard"]);
    expect((await edit("mem_1", m("fx_plain"), { role: "owner" })).status).toBe(200);
    expect(m("fx_plain").role).toBe("owner");
  });
});

describe("last owner", () => {
  test("the only owner cannot demote themselves", async () => {
    await expectDenied(await edit("mem_1", m("mem_1"), { role: "admin" }), "last_owner_required");
    expect(m("mem_1").role).toBe("owner");
  });

  test("with two owners, an owner can step down / be demoted", async () => {
    setRuntimeMember(member("fx_owner2", { role: "owner", capabilities: [...ALL] }));
    expect((await edit("mem_1", m("fx_owner2"), { role: "admin" })).status).toBe(200);
    expect(m("fx_owner2").role).toBe("admin");
  });

  test("owner can lower own capabilities", async () => {
    const self = m("mem_1");
    const res = await edit("mem_1", self, { capabilities: self.capabilities!.filter((c) => c !== "manage_billing") });
    expect(res.status).toBe(200);
    expect(m("mem_1").capabilities).not.toContain("manage_billing");
  });
});

describe("invite uses the same rules", () => {
  const invite = (actor: string, over: Record<string, unknown>) => post(actor, {
    email: "new.member@fixture.invalid", displayName: "新規", role: "member", jobRole: "custom",
    capabilities: ["view_dashboard"], ...over,
  });
  test("admin cannot invite with approve_actions", async () => {
    await expectDenied(await invite("fx_admin", { capabilities: ["view_dashboard", "approve_actions"] }), "owner_required_for_privileged_capability");
    expect(getRuntimeMembers().some((x) => x.email === "new.member@fixture.invalid")).toBe(false);
  });
  test("admin cannot invite as owner", async () => {
    await expectDenied(await invite("fx_admin", { role: "owner" }), "owner_required_for_owner_role");
  });
  test("admin can invite a view-only member; audit shows empty before", async () => {
    const res = await invite("fx_admin", {});
    expect(res.status).toBe(200);
    const audit = getRuntimeAudit().find((a) => a.action === "member.invited" && (a.metadata as { actorMemberId?: string }).actorMemberId === "fx_admin");
    expect(audit?.metadata).toMatchObject({ capabilitiesBefore: [], capabilitiesAfter: ["view_dashboard"], roleBefore: null, roleAfter: "member" });
  });
  test("owner can invite with approve_actions", async () => {
    expect((await invite("mem_1", { capabilities: ["view_dashboard", "approve_actions"] })).status).toBe(200);
  });
});

describe("input / IDOR", () => {
  test("unknown capability value is rejected (400) and nothing is written", async () => {
    await expectDenied(await edit("mem_1", m("fx_plain"), { capabilities: ["view_dashboard", "root" as HumanCapability] }), "unknown_capability", 400);
    expect(m("fx_plain").capabilities).toEqual(["view_dashboard"]);
  });
  test("unknown member id is 404 (never minted as a new row)", async () => {
    const count = getRuntimeMembers().length;
    const res = await post("mem_1", { id: "fx_does_not_exist", email: "x@fixture.invalid", displayName: "x", role: "member", capabilities: ["view_dashboard"] });
    await expectDenied(res, "target_not_found", 404);
    expect(getRuntimeMembers().length).toBe(count);
  });
  test("member without manage_team is refused", async () => {
    await expectDenied(await edit("fx_plain", m("fx_target"), { capabilities: ["view_dashboard", "approve_actions", "view_audit"] }), "manage_team_required");
  });
});

describe("GET exposes per-member editability for the checkboxes", () => {
  test("admin viewer: privileged boxes disabled for others, nothing addable on self", async () => {
    const res = await GET(new Request("https://fixture.invalid/api/team/members", { headers: { "x-member-id": "fx_admin" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.viewer.id).toBe("fx_admin");
    const target = body.members.find((x: { id: string }) => x.id === "fx_plain");
    expect(target.editable.capabilities.approve_actions).toBe(false);
    expect(target.editable.capabilities.view_audit).toBe(true);
    expect(target.editable.roles.owner).toBe(false);
    const self = body.members.find((x: { id: string }) => x.id === "fx_admin");
    expect(self.editable.capabilities.view_audit).toBe(false);
    expect(body.inviteEditable.capabilities.approve_actions).toBe(false);
  });
});
