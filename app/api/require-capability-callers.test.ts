import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { HumanCapability, OrgMember } from "@/lib/types";

/**
 * Table-driven: every production caller of requireCapability (directly or via
 * requireCredentialAdmin) is denied when the session has no active org_members
 * row — even when x-member-id / ?as= / body actorMemberId names the owner — and
 * the real owner (member row with role owner) still gets through.
 *
 * "Gate passed" is observed through a sentinel: every caller reads the org via
 * getCurrentOrgId() right after the gate, and the mock throws GATE_PASSED there,
 * so no data-layer code runs in this test.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
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

function member(id: string, role: OrgMember["role"], capabilities: HumanCapability[]): OrgMember {
  return {
    id,
    orgId: ORG,
    email: `${role}-${id.slice(0, 4)}@example.com`,
    displayName: id,
    role,
    jobRole: role === "owner" ? "owner" : "custom",
    capabilities,
    status: "active",
  } as OrgMember;
}

const OWNER = member("22222222-2222-4222-8222-222222222222", "owner", ALL_CAPS);
const ORG_MEMBERS = [OWNER];

let session: SessionContext;
let gateReads = 0;

const realSession = await import("@/lib/auth/session");
const realMembers = await import("@/lib/data/members");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getSessionContext: async () => session,
  getCurrentOrgId: async () => {
    gateReads++;
    throw new Error("GATE_PASSED");
  },
}));
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/data/members", () => ({
  ...realMembers,
  // Mirrors main's production resolveActorMember: exact id in org, else owner.
  resolveActorMember: async (actorId: string | null | undefined, orgId?: string | null) => {
    const list = orgId === ORG ? ORG_MEMBERS : [];
    return (
      list.find((m) => m.id === actorId) ??
      list.find((m) => m.role === "owner") ??
      list[0] ?? { ...member("unknown", "member", []), orgId: orgId || "" }
    );
  },
}));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Caller = {
  name: string;
  method: "POST" | "PATCH" | "DELETE";
  cap: HumanCapability;
  /** requireCredentialAdmin: owner/admin role is also required. */
  credentialAdmin: boolean;
  body: Record<string, unknown>;
  load: () => Promise<Handler>;
};

const ID = "emp_1";
const CALLERS: Caller[] = [
  { name: "POST /api/approvals/[id]/approve", method: "POST", cap: "approve_actions", credentialAdmin: false, body: {},
    load: async () => (await import("./approvals/[id]/approve/route")).POST as Handler },
  { name: "POST /api/approvals/[id]/reject", method: "POST", cap: "approve_actions", credentialAdmin: false, body: {},
    load: async () => (await import("./approvals/[id]/reject/route")).POST as Handler },
  { name: "POST /api/approvals/[id]/revise", method: "POST", cap: "approve_actions", credentialAdmin: false, body: { note: "直してください" },
    load: async () => (await import("./approvals/[id]/revise/route")).POST as Handler },
  { name: "POST /api/employees/[id]/terminate", method: "POST", cap: "hire_issue_credentials", credentialAdmin: false, body: {},
    load: async () => (await import("./employees/[id]/terminate/route")).POST as Handler },
  { name: "PATCH /api/employees/[id]/policy", method: "PATCH", cap: "hire_issue_credentials", credentialAdmin: false, body: {},
    load: async () => (await import("./employees/[id]/policy/route")).PATCH as Handler },
  { name: "PATCH /api/employees/[id]/binding", method: "PATCH", cap: "hire_issue_credentials", credentialAdmin: false, body: {},
    load: async () => (await import("./employees/[id]/binding/route")).PATCH as Handler },
  { name: "PATCH /api/employees/[id]/slack-identity", method: "PATCH", cap: "hire_issue_credentials", credentialAdmin: false, body: { postingAs: "bot" },
    load: async () => (await import("./employees/[id]/slack-identity/route")).PATCH as Handler },
  { name: "DELETE /api/employees/[id]/slack-identity", method: "DELETE", cap: "hire_issue_credentials", credentialAdmin: false, body: {},
    load: async () => (await import("./employees/[id]/slack-identity/route")).DELETE as Handler },
  { name: "POST /api/employees/issue", method: "POST", cap: "hire_issue_credentials", credentialAdmin: true,
    body: { displayName: "営業AI", roleLabel: "営業", scopes: ["calendar:read"] },
    load: async () => (await import("./employees/issue/route")).POST as unknown as Handler },
  { name: "POST /api/employees/[id]/rotate", method: "POST", cap: "hire_issue_credentials", credentialAdmin: true, body: {},
    load: async () => (await import("./employees/[id]/rotate/route")).POST as Handler },
  { name: "POST /api/admin-mcp/issue", method: "POST", cap: "hire_issue_credentials", credentialAdmin: true, body: {},
    load: async () => (await import("./admin-mcp/issue/route")).POST as unknown as Handler },
];

async function call(c: Caller, opts: { header?: string; bodyActor?: string } = {}) {
  const handler = await c.load();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.header) headers["x-member-id"] = opts.header;
  const url = new URL(`https://staffpass.test/api/caller/${ID}`);
  if (opts.header) url.searchParams.set("as", opts.header);
  const body = opts.bodyActor ? { ...c.body, actorMemberId: opts.bodyActor } : c.body;
  const req = new Request(url, { method: c.method, headers, body: JSON.stringify(body) });
  try {
    const res = await handler(req, { params: Promise.resolve({ id: ID }) });
    return { passed: false as const, status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) {
    if (e instanceof Error && e.message === "GATE_PASSED") return { passed: true as const };
    throw e;
  }
}

beforeEach(() => {
  gateReads = 0;
  session = { demo: false, userId: "user_1", email: "u@example.com", orgId: ORG, member: null };
});

const without = (cap: HumanCapability) => ALL_CAPS.filter((c) => c !== cap);

for (const c of CALLERS) {
  test(`${c.name}: no member row (orgId present) → 401, gate not passed`, async () => {
    const r = await call(c);
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("auth_required");
    }
    expect(gateReads).toBe(0);
  });

  test(`${c.name}: no member row (real session shape, orgId null) → 401`, async () => {
    session = { ...session, orgId: null };
    const r = await call(c);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.status).toBe(401);
  });

  test(`${c.name}: no member row + x-member-id / ?as= / body actorMemberId = owner → 401`, async () => {
    const r = await call(c, { header: OWNER.id, bodyActor: OWNER.id });
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.status).toBe(401);
  });

  test(`${c.name}: unauthenticated → 401`, async () => {
    session = { demo: false, userId: null, email: null, orgId: null, member: null };
    const r = await call(c);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.status).toBe(401);
  });

  test(`${c.name}: member without ${c.cap} → 403 (even when naming the owner)`, async () => {
    session = { ...session, member: member("33333333-3333-4333-8333-333333333333", c.credentialAdmin ? "admin" : "member", without(c.cap)) };
    const r = await call(c, { header: OWNER.id, bodyActor: OWNER.id });
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.status).toBe(403);
  });

  test(`${c.name}: member with ${c.cap}${c.credentialAdmin ? " (admin role)" : ""} → allowed`, async () => {
    session = { ...session, member: member("44444444-4444-4444-8444-444444444444", c.credentialAdmin ? "admin" : "member", ["view_dashboard", c.cap]) };
    const r = await call(c);
    expect(r.passed).toBe(true);
  });

  if (c.credentialAdmin) {
    test(`${c.name}: member role with ${c.cap} → 403 (owner/admin only, unchanged)`, async () => {
      session = { ...session, member: member("55555555-5555-4555-8555-555555555555", "member", ["view_dashboard", c.cap]) };
      const r = await call(c);
      expect(r.passed).toBe(false);
      if (!r.passed) expect(r.status).toBe(403);
    });
  }

  test(`${c.name}: real owner (member row, role owner) → allowed`, async () => {
    session = { ...session, member: OWNER };
    const r = await call(c);
    expect(r.passed).toBe(true);
  });
}
