import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { OrgMember } from "@/lib/types";

/**
 * Regression: POST /api/employees/issue mints a brand-new gb_emp_ secret.
 * It must require the same authority as rotate: owner/admin role AND
 * hire_issue_credentials. A member-role user that happens to hold the
 * capability (e.g. via the 総務 / AI推進 job-role pack) must be refused, and
 * an unauthenticated request must get 401 before anything is minted.
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
    jobRole: role === "member" ? "admin_affairs" : "owner",
    capabilities,
    status: "active",
  } as OrgMember;
}

let session: SessionContext = {
  demo: false,
  userId: "user_1",
  email: "x@example.com",
  orgId: "org_a",
  member: null,
};
let issueCalls: Array<Record<string, unknown>> = [];

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "production",
}));
mock.module("@/lib/billing/entitlements", () => ({
  assertBillingAllows: async () => ({ ok: true, entitlements: {} }),
}));
mock.module("@/lib/data", () => ({
  getOrgSodWarnPolicy: async () => null,
  listNotificationChannels: async () => [],
  appendAuditEvent: async () => undefined,
  runtimeModeLabel: () => "production",
  issueEmployee: async (input: Record<string, unknown>) => {
    issueCalls.push(input);
    return {
      employee: {
        id: "emp_new",
        orgId: String(input.orgId),
        displayName: String(input.displayName),
        approvalPolicy: "always_human",
        actionLimits: {},
      },
      credentialId: "cred_new",
      binding: { employeeId: "emp_new", status: "unlinked", credentialGeneration: 1 },
      generation: 1,
      demo: false,
    };
  },
}));

const { POST } = await import("./route");

function call() {
  return POST(
    new Request("https://staffpass.test/api/employees/issue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "営業AI",
        roleLabel: "営業",
        scopes: ["tools:read"],
        approvalPolicy: "always_human",
      }),
    })
  );
}

beforeEach(() => {
  issueCalls = [];
  session = { demo: false, userId: "user_1", email: "x@example.com", orgId: "org_a", member: null };
});

test("member role WITH hire_issue_credentials is refused (owner/admin only, no secret minted)", async () => {
  session = {
    ...session,
    member: member("member", ["view_dashboard", "view_employees", "manage_team", "hire_issue_credentials"]),
  };
  const res = await call();
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.code).toBe("owner_or_admin_required");
  expect(JSON.stringify(body)).not.toContain("gb_emp_");
  expect(issueCalls.length).toBe(0);
});

test("member without hire_issue_credentials is refused", async () => {
  session = { ...session, member: member("member", ["view_dashboard"]) };
  const res = await call();
  expect(res.status).toBe(403);
  expect(issueCalls.length).toBe(0);
});

test("admin without hire_issue_credentials is refused", async () => {
  session = { ...session, member: member("admin", ["view_dashboard", "manage_team"]) };
  const res = await call();
  expect(res.status).toBe(403);
  expect(issueCalls.length).toBe(0);
});

test("unauthenticated request gets 401 before anything is minted", async () => {
  session = { demo: false, userId: null, email: null, orgId: null, member: null };
  const res = await call();
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.error).toBe("auth_required");
  expect(issueCalls.length).toBe(0);
});

test("x-member-id header cannot impersonate an owner without a session", async () => {
  session = { demo: false, userId: null, email: null, orgId: null, member: null };
  const res = await POST(
    new Request("https://staffpass.test/api/employees/issue", {
      method: "POST",
      headers: { "content-type": "application/json", "x-member-id": "mem_owner" },
      body: JSON.stringify({ displayName: "x", roleLabel: "y", scopes: ["tools:read"], actorMemberId: "mem_owner" }),
    })
  );
  expect(res.status).toBe(401);
  expect(issueCalls.length).toBe(0);
});

test("admin with hire_issue_credentials issues; actor + hash prefix only reach the audit input", async () => {
  session = { ...session, member: member("admin", ALL_CAPS) };
  const res = await call();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(String(body.credential.oneTimeSecret).startsWith("gb_emp_")).toBe(true);
  expect(issueCalls.length).toBe(1);
  const input = issueCalls[0]!;
  expect(input.orgId).toBe("org_a");
  expect(input.actorEmail).toBe("admin@example.com");
  expect(input.actorMemberId).toBe("mem_admin");
  expect(String(input.secretHash)).toHaveLength(64);
});

test("owner with hire_issue_credentials can issue", async () => {
  session = { ...session, member: member("owner", ALL_CAPS) };
  const res = await call();
  expect(res.status).toBe(200);
  expect(issueCalls.length).toBe(1);
});
