import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { OrgMember } from "@/lib/types";

/**
 * Regression: POST /api/employees/[id]/rotate re-mints a gb_emp_ secret.
 * It must require the same authority as issuing (owner/admin + hire_issue_credentials)
 * and must leave an audit row that only carries a hash prefix (never the secret).
 */

const ALL_CAPS = [
  "view_dashboard",
  "view_employees",
  "view_audit",
  "approve_actions",
  "manage_spend_limits",
  "hire_issue_credentials",
  "manage_team",
  "manage_billing",
] as OrgMember["capabilities"];

function member(role: OrgMember["role"], capabilities: OrgMember["capabilities"]): OrgMember {
  return {
    id: `mem_${role}`,
    orgId: "org_a",
    email: `${role}@example.com`,
    displayName: role,
    role,
    jobRole: role === "member" ? "sales" : "owner",
    capabilities,
    status: "active",
  } as OrgMember;
}

let session: SessionContext = {
  demo: false,
  userId: "user_1",
  email: "viewer@example.com",
  orgId: "org_a",
  member: null,
};
let rotateCalls: Array<{ employeeId: string; orgId: string; fingerprint: string }> = [];
let auditRows: Array<Record<string, unknown>> = [];

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/data/members", () => ({
  // Fail closed: no implicit owner fallback in this test.
  resolveActorMember: async () => member("member", ["view_dashboard"]),
}));
mock.module("@/lib/data", () => ({
  getEmployee: async (id: string, orgId: string | null) =>
    id === "emp_1" && orgId === "org_a"
      ? {
          id: "emp_1",
          orgId: "org_a",
          displayName: "営業AI",
          credentialId: "cred_old",
          scopes: ["calendar:read"],
          allowedPurposes: ["sales.outreach"],
          approvalPolicy: {},
          actionLimits: {},
          spend: null,
          allowedAccounts: [],
        }
      : null,
  rotateCredential: async (employeeId: string, orgId: string, fingerprint: string) => {
    rotateCalls.push({ employeeId, orgId, fingerprint });
    return {
      binding: { employeeId, orgId, status: "linked", credentialGeneration: 2 },
      generation: 2,
    };
  },
  appendAuditEvent: async (row: Record<string, unknown>) => {
    auditRows.push(row);
  },
  bindingPublicView: (b: unknown) => b,
  runtimeModeLabel: () => "production",
}));

const { POST } = await import("./route");

function call() {
  return POST(
    new Request("https://staffpass.test/api/employees/emp_1/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ id: "emp_1" }) }
  );
}

beforeEach(() => {
  rotateCalls = [];
  auditRows = [];
});

test("member without hire_issue_credentials cannot rotate (no secret minted)", async () => {
  session = { ...session, member: member("member", ["view_dashboard", "view_employees"]) };
  const res = await call();
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(JSON.stringify(body)).not.toContain("gb_emp_");
  expect(rotateCalls.length).toBe(0);
});

test("member role with hire_issue_credentials is still refused (owner/admin only)", async () => {
  session = {
    ...session,
    member: member("member", ["view_dashboard", "view_employees", "hire_issue_credentials"]),
  };
  const res = await call();
  expect(res.status).toBe(403);
  expect(rotateCalls.length).toBe(0);
});

test("owner without hire_issue_credentials is refused", async () => {
  session = { ...session, member: member("owner", ["view_dashboard"]) };
  const res = await call();
  expect(res.status).toBe(403);
  expect(rotateCalls.length).toBe(0);
});

test("unauthenticated request is refused before any lookup", async () => {
  session = { demo: false, userId: null, email: null, orgId: null, member: null };
  const res = await call();
  expect([401, 403]).toContain(res.status);
  expect(rotateCalls.length).toBe(0);
  session = { demo: false, userId: "user_1", email: "x@example.com", orgId: "org_a", member: null };
});

test("admin with hire_issue_credentials rotates and audit carries only a hash prefix", async () => {
  session = { ...session, orgId: "org_a", member: member("admin", ALL_CAPS) };
  const res = await call();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(String(body.credential.oneTimeSecret).startsWith("gb_emp_")).toBe(true);
  expect(rotateCalls.length).toBe(1);

  const rotated = auditRows.filter((r) => r.action === "credential.rotated");
  expect(rotated.length).toBe(1);
  const row = rotated[0]!;
  expect(row.orgId).toBe("org_a");
  expect(row.employeeId).toBe("emp_1");
  expect(row.actorEmail).toBe("admin@example.com");
  const meta = row.metadata as Record<string, unknown>;
  expect(meta.generation).toBe(2);
  expect(String(meta.secretHashPrefix)).toHaveLength(12);
  expect(rotateCalls[0]!.fingerprint.startsWith(String(meta.secretHashPrefix))).toBe(true);

  const serialized = JSON.stringify(auditRows);
  expect(serialized).not.toContain(String(body.credential.oneTimeSecret));
  expect(serialized).not.toContain(rotateCalls[0]!.fingerprint);
  expect(serialized).not.toContain("gb_emp_");
});

test("owner with hire_issue_credentials can rotate", async () => {
  session = { ...session, orgId: "org_a", member: member("owner", ALL_CAPS) };
  const res = await call();
  expect(res.status).toBe(200);
  expect(rotateCalls.length).toBe(1);
});

test("cross-tenant employee id is not found for an admin of another org", async () => {
  session = { ...session, orgId: "org_b", member: { ...member("admin", ALL_CAPS), orgId: "org_b" } };
  const res = await call();
  expect(res.status).toBe(404);
  expect(rotateCalls.length).toBe(0);
});
