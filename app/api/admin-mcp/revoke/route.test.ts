import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { OrgMember } from "@/lib/types";

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

function member(role: OrgMember["role"], capabilities: OrgMember["capabilities"] = ALL_CAPS): OrgMember {
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

let session: SessionContext = { demo: false, userId: "user_1", email: "owner@example.com", orgId: "org_a", member: null };
let revoked: Array<{ orgId: string }> = [];
let auditRows: Array<Record<string, unknown>> = [];
let agent = {
  id: "adm_1",
  orgId: "org_a",
  status: "linked" as string,
  credentialFingerprint: "fp-live",
  credentialGeneration: 4,
};

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/app-url", () => ({ resolveAppOrigin: () => "https://staffpass.test" }));
mock.module("@/lib/data", () => ({
  appendAuditEvent: async (row: Record<string, unknown>) => {
    auditRows.push(row);
  },
}));
mock.module("@/lib/audit/admin-audit", () => ({
  appendAdminAuditEvent: async (row: Record<string, unknown>) => {
    auditRows.push(row);
  },
  humanAdminActor: (email: string, memberId?: string) => ({
    actorKind: "human" as const,
    actorEmail: email,
    actorMemberId: memberId,
  }),
}));
mock.module("@/lib/data/admin-agents", () => ({
  getOrgAdminAgent: async (orgId: string) => (agent.orgId === orgId ? agent : null),
  revokeOrgAdminAgent: async (input: { orgId: string }) => {
    revoked.push(input);
    if (agent.orgId !== input.orgId) throw new Error("org_mismatch");
    if (agent.status === "revoked" && agent.credentialFingerprint == null) {
      return { ...agent, alreadyRevoked: true };
    }
    agent = { ...agent, status: "revoked", credentialFingerprint: null };
    return agent;
  },
}));

const { POST } = await import("./route");

function call(opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  return POST(
    new Request("https://staffpass.test/api/admin-mcp/revoke", {
      method: "POST",
      headers: {
        origin: "https://staffpass.test",
        "content-type": "application/json",
        ...(opts.headers || {}),
      },
      body: JSON.stringify(opts.body ?? {}),
    })
  );
}

beforeEach(() => {
  revoked = [];
  auditRows = [];
  agent = {
    id: "adm_1",
    orgId: "org_a",
    status: "linked",
    credentialFingerprint: "fp-live",
    credentialGeneration: 4,
  };
  session = { demo: false, userId: "user_1", email: "owner@example.com", orgId: "org_a", member: member("owner") };
});

test("owner revokes; audit has actor_email, actorMemberId, generation, optional reason", async () => {
  const res = await call({ body: { reason: "key leaked" } });
  expect(res.status).toBe(200);
  expect(revoked).toEqual([{ orgId: "org_a" }]);
  expect(agent.status).toBe("revoked");
  expect(agent.credentialFingerprint).toBeNull();
  const row = auditRows.find((r) => r.action === "admin.revoke");
  expect(row).toBeDefined();
  expect(row!.actorEmail ?? (row!.actor as { actorEmail?: string } | undefined)?.actorEmail).toBe(
    "owner@example.com"
  );
  const meta = (row!.metadata ?? {}) as Record<string, unknown>;
  const actor = row!.actor as { actorKind?: string; actorMemberId?: string } | undefined;
  expect(meta.actorKind ?? actor?.actorKind).toBe("human");
  expect(meta.actorMemberId ?? actor?.actorMemberId).toBe("mem_owner");
  expect(meta.generation).toBe(4);
  expect(meta.reason).toBe("key leaked");
  expect(JSON.stringify(auditRows)).not.toContain("fp-live");
});

test("already revoked returns ok without a second mutation", async () => {
  agent = { ...agent, status: "revoked", credentialFingerprint: null };
  const res = await call();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok?: boolean };
  expect(body.ok).toBe(true);
  expect(revoked.length).toBe(1);
});

test("admin role is not enough", async () => {
  session = { ...session, member: member("admin") };
  const res = await call();
  expect(res.status).toBe(403);
  expect(revoked.length).toBe(0);
});

test("unauthenticated is 401", async () => {
  session = { demo: false, userId: null, email: null, orgId: null, member: null };
  const res = await call();
  expect(res.status).toBe(401);
  expect(revoked.length).toBe(0);
});

test("gb_adm_ bearer cannot revoke", async () => {
  const res = await call({ headers: { authorization: "Bearer gb_adm_not_allowed" } });
  expect(res.status).toBe(403);
  expect(revoked.length).toBe(0);
});

test("gb_emp_ bearer cannot revoke", async () => {
  const res = await call({ headers: { authorization: "Bearer gb_emp_not_allowed" } });
  expect(res.status).toBe(403);
  expect(revoked.length).toBe(0);
});

test("cross-origin is refused", async () => {
  const res = await call({ headers: { origin: "https://evil.example" } });
  expect(res.status).toBe(403);
  expect((await res.json() as { error?: string }).error).toBe("cross_origin_refused");
  expect(revoked.length).toBe(0);
});

test("session org is the only row touched", async () => {
  session = { ...session, orgId: "org_a", member: { ...member("owner"), orgId: "org_a" } };
  const res = await call();
  expect(res.status).toBe(200);
  expect(revoked).toEqual([{ orgId: "org_a" }]);
});
