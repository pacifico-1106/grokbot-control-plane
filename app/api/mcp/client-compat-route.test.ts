import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { directory, freshStore, seedClientAndGrant, ISSUER } from "@/lib/mcp-oauth/__tests__/fixtures";

/** PR-8: MCP client compat (securitySchemes, _meta challenge, staffpass_profile, instructions, server card). */
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
mock.module("@/lib/mcp-oauth/org-info", () => ({
  getOrgName: async (orgId: string) => (orgId === "org_a" ? "TOKYO307" : null),
  getSessionAal: async () => null,
}));
const GB = "gb_emp_client_compat_fixture";
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: (r: Request) => /^Bearer\s+(.+)$/i.exec(r.headers.get("authorization") || "")?.[1] ?? null,
  resolveEmployeeCredential: async (r: Request) => {
    const raw = /^Bearer\s+(.+)$/i.exec(r.headers.get("authorization") || "")?.[1];
    if (raw === GB)
      return { ok: true, credential: { employeeId: "emp_1", orgId: "org_a", generation: 3, credentialId: "cred_1", fingerprint: "f", binding: null, secretPrefix: "gb_emp_" } };
    return { ok: false, code: raw ? "invalid_credential" : "missing_credential", message: "nope", httpStatus: 401 };
  },
}));

const { __setOAuthStoreForTests } = await import("@/lib/data/oauth");
const { POST, GET } = await import("./route");
const { stableProfileId } = await import("@/lib/mcp-oauth/client-compat");

let store = freshStore();
const ENV = ["MCP_OAUTH_ENABLED", "MCP_PROTOCOL_NEGOTIATION_ENABLED", "MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE", "MCP_OAUTH_ORG_ALLOWLIST", "MCP_OAUTH_ORG_ALLOWLIST_REQUIRED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a"; // allowlist is fail-closed by default
  store = freshStore();
  __setOAuthStoreForTests(store);
  directory.reset();
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  __setOAuthStoreForTests(null);
});

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("https://staffpass.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const gb = { authorization: `Bearer ${GB}` };

test("flag OFF: tools/list has no staffpass_profile / securitySchemes; instructions + server card unchanged", async () => {
  const list = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, gb)).json();
  const names = list.result.tools.map((t: { name: string }) => t.name);
  expect(names).not.toContain("staffpass_profile");
  for (const t of list.result.tools) {
    expect(Object.keys(t).sort()).toEqual(["description", "inputSchema", "name"]);
  }
  const init = await (await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, gb)).json();
  expect(init.result.instructions).toContain("Authenticate with Authorization: Bearer gb_emp_….");
  expect(init.result.instructions).not.toContain("OAuth");
  const card = await (await GET()).json();
  expect(card.auth.oauth).toBeUndefined();
  expect(card.tools).not.toContain("staffpass_profile");
});

test("flag OFF: calling staffpass_profile is an unknown tool", async () => {
  const res = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "staffpass_profile" } }, gb)).json();
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("unknown_mcp_tool");
});

test("flag OFF: auth error body has no _meta challenge", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.error.data).toEqual({ code: "missing_credential" });
});

test("flag ON: every tool has oauth2 securitySchemes (top-level + _meta) and profile has outputSchema", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const { accessToken } = await seedClientAndGrant(store);
  const list = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${accessToken}` })).json();
  const tools = list.result.tools as Array<{ name: string; securitySchemes: unknown; _meta: { securitySchemes: unknown }; outputSchema: { required: string[] } }>;
  expect(tools.map((t) => t.name)).toContain("staffpass_profile");
  for (const t of tools) {
    expect(t.securitySchemes).toEqual([{ type: "oauth2", scopes: ["staffpass.employee"] }]);
    expect(t._meta.securitySchemes).toEqual(t.securitySchemes);
  }
  const profile = tools.find((t) => t.name === "staffpass_profile")!;
  expect(profile.outputSchema.required).toContain("id");
});

test("flag ON: staffpass_profile via sp_at_ → stable opaque id, org name, openai/profile meta, no secrets", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const { accessToken } = await seedClientAndGrant(store);
  const call = async (h: Record<string, string>) =>
    (await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "staffpass_profile", arguments: {} } }, h)).json()).result;
  const r = await call({ authorization: `Bearer ${accessToken}` });
  expect(r.isError).toBeUndefined();
  expect(r.structuredContent).toEqual({
    id: stableProfileId("org_a", "emp_1"),
    displayName: "営業AI",
    roleLabel: "営業アシスタント",
    org: { name: "TOKYO307" },
    authMethod: "oauth",
  });
  expect(r.structuredContent.id).toMatch(/^sp_prof_[0-9a-f]{32}$/);
  expect(r.structuredContent.id).not.toContain("emp_1");
  expect(r._meta["openai/profile"]).toEqual({ id: r.structuredContent.id, name: "営業AI", role: "営業アシスタント", org: "TOKYO307" });
  const text = JSON.stringify(r);
  expect(text).not.toContain(accessToken);
  expect(text).not.toContain("gb_emp_");
  // Same employee via gb_emp_ → same id, different authMethod.
  const r2 = await call(gb);
  expect(r2.structuredContent.id).toBe(r.structuredContent.id);
  expect(r2.structuredContent.authMethod).toBe("gb_emp");
});

test("flag ON: tool-level auth error mirrors the challenge in error.data._meta", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const missing = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "staffpass_whoami" } })).json();
  expect(missing.error.data._meta["mcp/www_authenticate"]).toEqual([
    `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"`,
  ]);
  const bad = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer sp_at_${"z".repeat(43)}` })).json();
  expect(bad.error.data._meta["mcp/www_authenticate"][0]).toContain('error="invalid_token"');
  expect(JSON.stringify(bad)).not.toContain("z".repeat(43));
});

test("flag ON: instructions mention OAuth + gb_emp_; server card advertises AS/PRM", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const init = await (await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, gb)).json();
  expect(init.result.instructions).toContain("OAuth");
  expect(init.result.instructions).toContain("gb_emp_");
  expect(init.result.instructions).toContain("staffpass_profile");
  expect(init.result.instructions).not.toContain("Authenticate with Authorization: Bearer gb_emp_….");
  const card = await (await GET()).json();
  expect(card.auth.oauth.authorizationServer).toBe(ISSUER);
  expect(card.auth.oauth.protectedResourceMetadata).toBe(`${ISSUER}/.well-known/oauth-protected-resource/api/mcp`);
  expect(card.tools).toContain("staffpass_profile");
});

test("profile for an employee from another org is refused (cred/org mismatch)", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  directory.employees.set("emp_1", { ...directory.employees.get("emp_1")!, orgId: "org_b" });
  const r = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "staffpass_profile" } }, gb)).json()).result;
  expect(r.isError).toBe(true);
  expect(r.structuredContent.code).toBe("employee_not_found");
  expect(r.structuredContent.id).toBeUndefined();
});

