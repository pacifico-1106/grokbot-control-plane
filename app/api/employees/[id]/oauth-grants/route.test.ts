import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OrgMember } from "@/lib/types";
import { CLAUDE_CLIENT, RESOURCE } from "@/lib/mcp-oauth/__tests__/fixtures";

/** PR-7: grant list / revoke API, terminate bulk revoke. */
let actor: OrgMember;
let orgId: string | null = "org_a";
const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
const terminated: string[] = [];

mock.module("@/lib/mode", () => ({ isDemoMode: () => false, isSupabaseConfigured: () => true, runtimeModeLabel: () => "production", isStripeConfigured: () => false, isResendConfigured: () => false }));
mock.module("@/lib/auth/session", () => ({ getCurrentOrgId: async () => orgId, getSessionContext: async () => ({ demo: false, userId: "u", email: actor.email, orgId, member: actor }) }));
mock.module("@/lib/team/demo-actor", () => ({
  requireCapability: async () =>
    (actor.capabilities ?? []).includes("hire_issue_credentials")
      ? { ok: true, actor }
      : { ok: false, response: new Response(JSON.stringify({ error: "capability_denied" }), { status: 403 }) },
}));
const employees: Record<string, { id: string; orgId: string; displayName: string; credentialId: string; status: string }> = {
  emp_1: { id: "emp_1", orgId: "org_a", displayName: "営業AI", credentialId: "cred_1", status: "active" },
  emp_2: { id: "emp_2", orgId: "org_a", displayName: "経理AI", credentialId: "cred_2", status: "active" },
  emp_b: { id: "emp_b", orgId: "org_b", displayName: "他社AI", credentialId: "cred_b", status: "active" },
};
const pushAudit = async (e: { action: string; metadata: Record<string, unknown> }) => {
  audits.push({ action: e.action, metadata: e.metadata });
};
const actualAudit = await import("@/lib/data/audit");
mock.module("@/lib/data/audit", () => ({ ...actualAudit, appendAuditEvent: pushAudit }));
const actualData = await import("@/lib/data");
mock.module("@/lib/data", () => ({
  ...actualData,
  appendAuditEvent: pushAudit,
  getEmployee: async (id: string, org: string | null) => (employees[id] && employees[id].orgId === org ? employees[id] : null),
  terminateEmployee: async ({ orgId: o, employeeId }: { orgId: string; employeeId: string }) => {
    const e = employees[employeeId];
    if (!e || e.orgId !== o) return null;
    terminated.push(employeeId);
    return { ...e, status: "suspended" };
  },
}));

const { __setOAuthStoreForTests, createMemoryOAuthStore } = await import("@/lib/data/oauth");
const list = await import("./route");
const one = await import("./[grantId]/route");
const terminate = await import("@/app/api/employees/[id]/terminate/route");

let store = createMemoryOAuthStore();
const saved = process.env.MCP_OAUTH_ENABLED;

async function grantFor(employeeId: string, org = "org_a") {
  await store.upsertClient({ clientId: CLAUDE_CLIENT, registrationType: "cimd", clientName: "Claude", clientUri: null, logoUri: null, redirectUris: [], tokenEndpointAuthMethod: "none", metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active", createdIpHash: null });
  const g = await store.createGrant({ orgId: org, employeeId, clientId: CLAUDE_CLIENT, credentialIdAtGrant: null, grantedByMemberId: null, grantedByEmail: "owner@x", resource: RESOURCE, scope: ["staffpass.employee"], expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  await store.createAccessToken({ tokenHash: `h_${g.id}`, grantId: g.id, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  return g;
}

const ctx = (id: string, grantId?: string) => ({ params: Promise.resolve(grantId ? { id, grantId } : { id }) }) as never;

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  store = createMemoryOAuthStore();
  __setOAuthStoreForTests(store);
  actor = { id: "m1", orgId: "org_a", email: "admin@x", displayName: "a", role: "admin", status: "active", capabilities: ["hire_issue_credentials"] } as OrgMember;
  orgId = "org_a";
  audits.length = 0;
  terminated.length = 0;
});
afterEach(() => {
  __setOAuthStoreForTests(null);
  if (saved === undefined) delete process.env.MCP_OAUTH_ENABLED;
  else process.env.MCP_OAUTH_ENABLED = saved;
});

describe("GET /api/employees/[id]/oauth-grants", () => {
  test("flag OFF → 404", async () => {
    delete process.env.MCP_OAUTH_ENABLED;
    expect((await list.GET(new Request("https://x/"), ctx("emp_1"))).status).toBe(404);
  });
  test("lists only this employee's grants, public view (no tokens)", async () => {
    await grantFor("emp_1");
    await grantFor("emp_2");
    const res = await list.GET(new Request("https://x/"), ctx("emp_1"));
    const body = await res.json();
    expect(body.grants.length).toBe(1);
    expect(body.grants[0].clientHost).toBe("claude.ai");
    expect(JSON.stringify(body)).not.toContain("h_");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  test("employee of another org → 404; no capability → 403", async () => {
    expect((await list.GET(new Request("https://x/"), ctx("emp_b"))).status).toBe(404);
    actor = { ...actor, capabilities: [] } as OrgMember;
    expect((await list.GET(new Request("https://x/"), ctx("emp_1"))).status).toBe(403);
  });
});

describe("DELETE /api/employees/[id]/oauth-grants/[grantId]", () => {
  const del = (id: string, gid: string, headers: Record<string, string> = {}) =>
    one.DELETE(new Request(`https://x/api/employees/${id}/oauth-grants/${gid}`, { method: "DELETE", headers }), ctx(id, gid));

  test("revokes grant + its tokens, audit oauth.grant_revoked", async () => {
    const g = await grantFor("emp_1");
    const res = await del("emp_1", g.id);
    expect(res.status).toBe(200);
    expect((await store.getGrant(g.id))?.status).toBe("revoked");
    expect((await store.getAccessToken(`h_${g.id}`))?.revokedAt).toBeTruthy();
    expect(audits.map((a) => a.action)).toEqual(["oauth.grant_revoked"]);
  });
  test("IDOR: grant of another employee (same org) or another org → 404, untouched", async () => {
    const g2 = await grantFor("emp_2");
    const gb = await grantFor("emp_b", "org_b");
    expect((await del("emp_1", g2.id)).status).toBe(404);
    expect((await del("emp_1", gb.id)).status).toBe(404);
    expect((await store.getGrant(g2.id))?.status).toBe("active");
    expect((await store.getGrant(gb.id))?.status).toBe("active");
  });
  test("cross-origin → 403; no capability → 403", async () => {
    const g = await grantFor("emp_1");
    expect((await del("emp_1", g.id, { origin: "https://evil.example" })).status).toBe(403);
    actor = { ...actor, capabilities: [] } as OrgMember;
    expect((await del("emp_1", g.id)).status).toBe(403);
    expect((await store.getGrant(g.id))?.status).toBe("active");
  });
});

describe("terminate revokes OAuth grants (flag ON only)", () => {
  const post = (id: string) => terminate.POST(new Request("https://x/", { method: "POST", body: "{}" }), ctx(id));
  test("ON: all active grants of the employee revoked + one audit row", async () => {
    const a = await grantFor("emp_1");
    const b = await grantFor("emp_1");
    const other = await grantFor("emp_2");
    const res = await post("emp_1");
    expect(await res.json()).toMatchObject({ ok: true, oauthGrantsRevoked: 2 });
    expect((await store.getGrant(a.id))?.status).toBe("revoked");
    expect((await store.getGrant(b.id))?.status).toBe("revoked");
    expect((await store.getGrant(other.id))?.status).toBe("active");
    expect(audits.filter((x) => x.action === "oauth.grant_revoked").length).toBe(1);
  });
  test("OFF: terminate response unchanged (no oauth key), store untouched", async () => {
    delete process.env.MCP_OAUTH_ENABLED;
    const a = await grantFor("emp_1");
    const body = await (await post("emp_1")).json();
    expect("oauthGrantsRevoked" in body).toBe(false);
    expect((await store.getGrant(a.id))?.status).toBe("active");
  });
});
