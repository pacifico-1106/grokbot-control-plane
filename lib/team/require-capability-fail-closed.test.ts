import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { HumanCapability, OrgMember } from "@/lib/types";

/**
 * requireCapability must fail closed in production (木村 decision, PR #261 follow-up):
 * a session without an active org_members row is denied (401 auth_required) —
 * never resolved to the org owner, and never to a member named by
 * x-member-id / ?as= / body actorMemberId. DEMO keeps the in-memory demo actor.
 */

const ALL_CAPS: HumanCapability[] = [
  "view_dashboard",
  "view_employees",
  "view_audit",
  "approve_actions",
  "manage_spend_limits",
  "hire_issue_credentials",
  "manage_team",
  "manage_billing",
];

function member(
  id: string,
  role: OrgMember["role"],
  capabilities: HumanCapability[],
  extra: Partial<OrgMember> = {}
): OrgMember {
  return {
    id,
    orgId: "11111111-1111-4111-8111-111111111111",
    email: `${id}@example.com`,
    displayName: id,
    role,
    jobRole: role === "owner" ? "owner" : "custom",
    capabilities,
    status: "active",
    ...extra,
  } as OrgMember;
}

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = member("22222222-2222-4222-8222-222222222222", "owner", ALL_CAPS);
const VIEWER = member("33333333-3333-4333-8333-333333333333", "member", ["view_dashboard"]);
const APPROVER = member("44444444-4444-4444-8444-444444444444", "member", ["view_dashboard", "approve_actions"]);
const ORG_MEMBERS = [OWNER, VIEWER, APPROVER];

let demo = false;
let session: SessionContext;
let resolveCalls = 0;

const realMembers = await import("@/lib/data/members");
mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/mode", () => ({ isDemoMode: () => demo }));
mock.module("@/lib/data/members", () => ({
  ...realMembers,
  // Same shape as the production resolveActorMember on main: exact id within
  // the org, otherwise the org owner (the fail-open fallback under test).
  resolveActorMember: async (actorId: string | null | undefined, orgId?: string | null) => {
    resolveCalls++;
    if (demo) return realMembers.resolveActorMember(actorId, orgId);
    const list = orgId === ORG ? ORG_MEMBERS : [];
    return (
      list.find((m) => m.id === actorId) ??
      list.find((m) => m.role === "owner") ??
      list[0] ?? member("unknown", "member", [], { orgId: orgId || "" })
    );
  },
}));

const { requireCapability } = await import("./demo-actor");

function req(opts: { header?: string; as?: string } = {}) {
  const url = new URL("https://staffpass.test/api/x");
  if (opts.as) url.searchParams.set("as", opts.as);
  const headers: Record<string, string> = {};
  if (opts.header) headers["x-member-id"] = opts.header;
  return new Request(url, { method: "POST", headers });
}

beforeEach(() => {
  demo = false;
  resolveCalls = 0;
  session = { demo: false, userId: "user_1", email: "u@example.com", orgId: ORG, member: null };
});

async function expectNoMemberDenied(gate: Awaited<ReturnType<typeof requireCapability>>) {
  expect(gate.ok).toBe(false);
  if (gate.ok) return;
  expect(gate.response.status).toBe(401);
  const body = await gate.response.json();
  expect(body.ok).toBe(false);
  expect(body.error).toBe("auth_required");
  expect(body.code).toBe("active_member_required");
  // Never echo a resolved (owner / fallback) actor back.
  expect(JSON.stringify(body)).not.toContain(OWNER.id);
  expect(body.actorId).toBeUndefined();
}

const NO_MEMBER_SESSIONS: Array<[string, () => SessionContext]> = [
  ["unauthenticated (no user, no org)", () => ({ demo: false, userId: null, email: null, orgId: null, member: null })],
  ["signed in, no org_members row (real getSessionContext shape)", () => ({ demo: false, userId: "user_1", email: "u@example.com", orgId: null, member: null })],
  ["signed in, orgId present but member row missing", () => ({ demo: false, userId: "user_1", email: "u@example.com", orgId: ORG, member: null })],
  ["orgId present, no user, no member", () => ({ demo: false, userId: null, email: null, orgId: ORG, member: null })],
];

for (const [label, make] of NO_MEMBER_SESSIONS) {
  for (const cap of ALL_CAPS) {
    test(`production: ${label} → ${cap} denied (401, no owner fallback)`, async () => {
      session = make();
      await expectNoMemberDenied(await requireCapability(req(), cap));
      expect(resolveCalls).toBe(0);
    });
  }
}

test("production: no member + x-member-id naming the owner → denied (no impersonation)", async () => {
  await expectNoMemberDenied(await requireCapability(req({ header: OWNER.id }), "hire_issue_credentials"));
  expect(resolveCalls).toBe(0);
});

test("production: no member + ?as=owner → denied", async () => {
  await expectNoMemberDenied(await requireCapability(req({ as: OWNER.id }), "approve_actions"));
  expect(resolveCalls).toBe(0);
});

test("production: no member + body actorMemberId naming the owner → denied", async () => {
  await expectNoMemberDenied(await requireCapability(req(), "hire_issue_credentials", OWNER.id));
  expect(resolveCalls).toBe(0);
});

test("production: no member + legacy default actor id mem_1 → denied", async () => {
  await expectNoMemberDenied(await requireCapability(req({ header: "mem_1" }), "manage_team", "mem_1"));
});

test("production: session member from a different org than the session org → denied", async () => {
  session = { ...session, member: { ...OWNER, orgId: "99999999-9999-4999-8999-999999999999" } };
  await expectNoMemberDenied(await requireCapability(req(), "approve_actions"));
});

test("production: session member that is not active → denied", async () => {
  session = { ...session, member: { ...OWNER, status: "disabled" } };
  await expectNoMemberDenied(await requireCapability(req(), "approve_actions"));
});

test("production: member without the capability → 403 capability_denied", async () => {
  session = { ...session, member: VIEWER };
  const gate = await requireCapability(req(), "approve_actions");
  expect(gate.ok).toBe(false);
  if (gate.ok) return;
  expect(gate.response.status).toBe(403);
  const body = await gate.response.json();
  expect(body.error).toBe("capability_denied");
  expect(body.code).toBe("approve_actions");
  expect(body.actorId).toBe(VIEWER.id);
});

test("production: member without the capability cannot borrow the owner via x-member-id / body", async () => {
  session = { ...session, member: VIEWER };
  const gate = await requireCapability(req({ header: OWNER.id, as: OWNER.id }), "hire_issue_credentials", OWNER.id);
  expect(gate.ok).toBe(false);
  if (gate.ok) return;
  expect(gate.response.status).toBe(403);
});

test("production: member with the capability → allowed as the session member", async () => {
  session = { ...session, member: APPROVER };
  const gate = await requireCapability(req({ header: OWNER.id }), "approve_actions", OWNER.id);
  expect(gate.ok).toBe(true);
  if (gate.ok) expect(gate.actor.id).toBe(APPROVER.id);
  expect(resolveCalls).toBe(0);
});

for (const cap of ALL_CAPS) {
  test(`production: real owner (member row, role owner) → ${cap} allowed`, async () => {
    session = { ...session, member: OWNER };
    const gate = await requireCapability(req(), cap);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.actor.id).toBe(OWNER.id);
  });
}

test("DEMO (unchanged): no header → demo owner mem_1", async () => {
  demo = true;
  session = { demo: true, userId: null, email: "owner@example.com", orgId: "org_demo", member: null };
  const gate = await requireCapability(req(), "hire_issue_credentials");
  expect(gate.ok).toBe(true);
  if (gate.ok) expect(gate.actor.id).toBe("mem_1");
});

test("DEMO (unchanged): x-member-id picks the in-memory demo member (and its capabilities)", async () => {
  demo = true;
  session = { demo: true, userId: null, email: "owner@example.com", orgId: "org_demo", member: null };
  const denied = await requireCapability(req({ header: "mem_2" }), "hire_issue_credentials");
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.response.status).toBe(403);
  const allowed = await requireCapability(req({ as: "mem_2" }), "approve_actions");
  expect(allowed.ok).toBe(true);
  if (allowed.ok) expect(allowed.actor.id).toBe("mem_2");
});
