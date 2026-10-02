import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { OrgMember } from "@/lib/types";

/**
 * Regression: POST /api/admin-mcp/issue mints the tenant gb_adm_ bearer. That
 * bearer can run employees.issue (→ gb_emp_ after a human approval), so it is a
 * credential-issuing path and needs owner/admin AND hire_issue_credentials,
 * with an audit row that carries only a hash prefix.
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
    jobRole: "owner",
    capabilities,
    status: "active",
  } as OrgMember;
}

let session: SessionContext = { demo: false, userId: "user_1", email: "x@example.com", orgId: "org_a", member: null };
let issued: Array<{ orgId: string; secretHash: string }> = [];
let auditRows: Array<Record<string, unknown>> = [];

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/data/members", () => ({
  resolveActorMember: async () => member("member", ["view_dashboard"]),
}));
mock.module("@/lib/data", () => ({
  appendAuditEvent: async (row: Record<string, unknown>) => {
    auditRows.push(row);
  },
}));
mock.module("@/lib/data/admin-agents", () => ({
  mintAdminSecret: () => ({ raw: "gb_adm_rawsecretvalue", hash: "c".repeat(64), prefix: "gb_adm_rawsecr" }),
  issueOrgAdminAgent: async (input: { orgId: string; secretHash: string }) => {
    issued.push(input);
    return { id: "adm_1", orgId: input.orgId, credentialGeneration: 2 };
  },
  adminAgentPublicView: (a: unknown) => a,
}));

const { POST } = await import("./route");

function call() {
  return POST(new Request("https://staffpass.test/api/admin-mcp/issue", { method: "POST" }));
}

beforeEach(() => {
  issued = [];
  auditRows = [];
  session = { demo: false, userId: "user_1", email: "x@example.com", orgId: "org_a", member: null };
});

test("admin WITHOUT hire_issue_credentials cannot mint gb_adm_", async () => {
  session = { ...session, member: member("admin", ["view_dashboard", "manage_team"]) };
  const res = await call();
  expect(res.status).toBe(403);
  expect(issued.length).toBe(0);
});

test("member role with hire_issue_credentials cannot mint gb_adm_", async () => {
  session = { ...session, member: member("member", ALL_CAPS) };
  const res = await call();
  expect(res.status).toBe(403);
  expect(issued.length).toBe(0);
});

test("unauthenticated gets 401", async () => {
  session = { demo: false, userId: null, email: null, orgId: null, member: null };
  const res = await call();
  expect(res.status).toBe(401);
  expect(issued.length).toBe(0);
});

test("owner with hire_issue_credentials mints; audit has hash prefix only", async () => {
  session = { ...session, member: member("owner", ALL_CAPS) };
  const res = await call();
  expect(res.status).toBe(200);
  expect(issued.length).toBe(1);
  expect(issued[0]!.orgId).toBe("org_a");
  const row = auditRows.find((r) => r.action === "admin.link");
  expect(row).toBeDefined();
  expect(row!.actorEmail).toBe("owner@example.com");
  const meta = row!.metadata as Record<string, unknown>;
  expect(meta.secretHashPrefix).toBe("c".repeat(12));
  expect(meta.actorMemberId).toBe("mem_owner");
  const serialized = JSON.stringify(auditRows);
  expect(serialized).not.toContain("c".repeat(64));
  expect(serialized).not.toContain("gb_adm_rawsecretvalue");
});
