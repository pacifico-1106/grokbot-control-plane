import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { directory, freshStore, seedClientAndGrant, ISSUER } from "./fixtures";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const actualData = await import("@/lib/data");
mock.module("@/lib/data", () => ({
  ...actualData,
  getEmployeeById: async (id: string) => directory.employees.get(id) ?? null,
  getBinding: async (id: string) => directory.bindings.get(id) ?? undefined,
}));
mock.module("@/lib/mcp-oauth/employee-state", () => ({
  getCurrentEmployeeCredential: async (id: string) => directory.credentials.get(id) ?? null,
}));
let legacyCalls = 0;
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: () => null,
  resolveEmployeeCredential: async () => {
    legacyCalls++;
    return { ok: false, code: "invalid_credential", message: "credential must start with gb_emp_", httpStatus: 401 };
  },
}));

const { __setOAuthStoreForTests } = await import("@/lib/data/oauth");
const { resolveMcpCredential, wwwAuthenticate } = await import("../resource-server");

let store = freshStore();
const ENV = ["MCP_OAUTH_ENABLED", "MCP_OAUTH_ORG_ALLOWLIST", "MCP_OAUTH_ISSUER"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  process.env.MCP_OAUTH_ENABLED = "1";
  store = freshStore();
  __setOAuthStoreForTests(store);
  directory.reset();
  legacyCalls = 0;
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  __setOAuthStoreForTests(null);
});

const req = (token: string, header = "authorization") =>
  new Request("https://staffpass.test/api/mcp", { headers: { [header]: header === "authorization" ? `Bearer ${token}` : token } });

test("valid sp_at_ resolves to the granted employee with authMethod oauth", async () => {
  const { accessToken, grant } = await seedClientAndGrant(store);
  const r = await resolveMcpCredential(req(accessToken));
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.credential.employeeId).toBe("emp_1");
    expect(r.credential.orgId).toBe("org_a");
    expect(r.credential.authMethod).toBe("oauth");
    expect(r.credential.oauthGrantId).toBe(grant.id);
    expect(r.credential.oauthClientHost).toBe("claude.ai");
    expect(r.credential.credentialId).toBe("cred_1");
  }
});

test("flag OFF: sp_at_ goes to the legacy resolver and is rejected", async () => {
  const { accessToken } = await seedClientAndGrant(store);
  delete process.env.MCP_OAUTH_ENABLED;
  const r = await resolveMcpCredential(req(accessToken));
  expect(r.ok).toBe(false);
  expect(legacyCalls).toBe(1);
});

test("sp_at_ via x-staffpass-credential is never accepted as OAuth", async () => {
  const { accessToken } = await seedClientAndGrant(store);
  const r = await resolveMcpCredential(req(accessToken, "x-staffpass-credential"));
  expect(r.ok).toBe(false);
  expect(legacyCalls).toBe(1);
});

test("unknown / revoked / expired access token → invalid_token", async () => {
  const { accessToken, accessHash } = await seedClientAndGrant(store);
  expect((await resolveMcpCredential(req("sp_at_" + "x".repeat(43)))).ok).toBe(false);
  await store.revokeAccessToken(accessHash, new Date().toISOString());
  const r = await resolveMcpCredential(req(accessToken));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.oauthError).toBe("invalid_token");
});

test("revoked grant stops the token immediately", async () => {
  const { accessToken, grant } = await seedClientAndGrant(store);
  await store.revokeGrant(grant.id, "admin@example.com", "manual", new Date().toISOString());
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(false);
});

test("grant for another resource (audience) is refused", async () => {
  const { accessToken } = await seedClientAndGrant(store, { resource: "https://evil.example/api/mcp" });
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(false);
});

test("expired grant is refused", async () => {
  const { accessToken } = await seedClientAndGrant(store, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(false);
});

test("employee suspended / moved to another org → refused (S9)", async () => {
  const { accessToken } = await seedClientAndGrant(store);
  directory.employees.set("emp_1", { ...directory.employees.get("emp_1")!, status: "suspended" });
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(false);
  directory.employees.set("emp_1", { ...directory.employees.get("emp_1")!, status: "active", orgId: "org_b" });
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(false);
});

test("binding revoked → 403; credential revoked/expired → refused", async () => {
  const { accessToken } = await seedClientAndGrant(store);
  directory.bindings.set("emp_1", { ...directory.bindings.get("emp_1")!, status: "revoked" });
  const r = await resolveMcpCredential(req(accessToken));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.httpStatus).toBe(403);
  directory.reset();
  directory.credentials.set("emp_1", null);
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(false);
  directory.credentials.set("emp_1", { credentialId: "cred_1", expiresAt: new Date(Date.now() - 1).toISOString() });
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(false);
});

test("org allowlist (pilot) blocks other orgs", async () => {
  const { accessToken } = await seedClientAndGrant(store);
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_pilot";
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(false);
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_pilot,org_a";
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(true);
});

test("WWW-Authenticate carries resource_metadata + scope, error only when asked", () => {
  const plain = wwwAuthenticate();
  expect(plain).toBe(`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"`);
  const err = wwwAuthenticate({ error: "invalid_token", description: 'bad"x' });
  expect(err.startsWith('Bearer error="invalid_token", error_description="badx"')).toBe(true);
});

test("blocked client → its live access token is refused at the resource server", async () => {
  const { accessToken } = await seedClientAndGrant(store);
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(true);
  const c = (await store.getClient("https://claude.ai/oauth/mcp-client.json"))!;
  await store.upsertClient({ ...c, status: "blocked" });
  const r = await resolveMcpCredential(req(accessToken));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.httpStatus).toBe(401);
});
