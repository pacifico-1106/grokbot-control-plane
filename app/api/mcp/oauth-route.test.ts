import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { directory, freshStore, seedClientAndGrant, ISSUER } from "@/lib/mcp-oauth/__tests__/fixtures";

/** /api/mcp + discovery with MCP_OAUTH_ENABLED (production mode simulated). */
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
const GB = "gb_emp_oauth_route_fixture";
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
const { POST } = await import("./route");
const admin = await import("./admin/route");
const prm = await import("@/app/api/oauth/meta/protected-resource/route");
const asm = await import("@/app/api/oauth/meta/authorization-server/route");

let store = freshStore();
const ENV = ["MCP_OAUTH_ENABLED", "MCP_OAUTH_DCR_ENABLED", "MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE", "MCP_OAUTH_ISSUER", "MCP_OAUTH_ORG_ALLOWLIST", "MCP_OAUTH_ORG_ALLOWLIST_REQUIRED"];
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

const rpc = (body: unknown, headers: Record<string, string> = {}, handler = POST, url = "https://staffpass.test/api/mcp") =>
  handler(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

test("flag OFF: discovery 404, unauth initialize 200 without challenge", async () => {
  expect((await prm.GET(new Request("https://x/api/oauth/meta/protected-resource?kind=mcp"))).status).toBe(404);
  expect((await asm.GET()).status).toBe(404);
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(res.status).toBe(200);
  expect(res.headers.get("www-authenticate")).toBeNull();
  expect(res.headers.get("access-control-expose-headers")).toBeNull();
});

test("flag ON + legacy explicitly false: unauthenticated initialize / tools/list / notifications → 401 + resource_metadata", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE = "false";
  for (const method of ["initialize", "tools/list", "ping", "notifications/initialized"]) {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"`
    );
  }
});

test("flag ON + legacy UNSET (default = today): unauth lifecycle stays 200/202, tools/list 401 + challenge", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(200);
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "server/discover" })).status).toBe(200);
  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(list.status).toBe(401);
  expect(list.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"`
  );
});

for (const v of ["", "true", "1", "yes", "garbage"]) {
  test(`flag ON + legacy=${JSON.stringify(v)} (not an explicit false) → unauth initialize 200`, async () => {
    process.env.MCP_OAUTH_ENABLED = "1";
    process.env.MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE = v;
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(200);
  });
}
for (const v of ["false", "0", "off", "disabled", "no", " FALSE "]) {
  test(`flag ON + legacy=${JSON.stringify(v)} → unauth initialize 401`, async () => {
    process.env.MCP_OAUTH_ENABLED = "1";
    process.env.MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE = v;
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(401);
  });
}

test("flag ON + legacy hatch: unauth initialize stays 200, tools/list still 401", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE = "1";
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(200);
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
});

test("flag ON: gb_emp_ Bearer unchanged (initialize + tools/list)", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const h = { authorization: `Bearer ${GB}` };
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, h)).status).toBe(200);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, h);
  expect(list.status).toBe(200);
});

test("flag ON: sp_at_ works for tools/list; bad sp_at_ → 401 error=invalid_token", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const { accessToken } = await seedClientAndGrant(store);
  expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { authorization: `Bearer ${accessToken}` })).status).toBe(200);
  const bad = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { authorization: `Bearer sp_at_${"y".repeat(43)}` });
  expect(bad.status).toBe(401);
  expect(bad.headers.get("www-authenticate") || "").toContain('error="invalid_token"');
  const body = JSON.stringify(await bad.json());
  expect(body).not.toContain("y".repeat(43));
});

test("flag ON: admin MCP refuses sp_at_ (S14)", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const { accessToken } = await seedClientAndGrant(store);
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${accessToken}` }, admin.POST, "https://staffpass.test/api/mcp/admin");
  expect(res.status).toBe(401);
});

test("flag ON: PRM (mcp + root) and AS metadata shapes; issuer matches exactly", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const mcp = await (await prm.GET(new Request("https://x/api/oauth/meta/protected-resource?kind=mcp"))).json();
  expect(mcp.resource).toBe(`${ISSUER}/api/mcp`);
  expect(mcp.authorization_servers).toEqual([ISSUER]);
  expect(mcp.scopes_supported).toEqual(["staffpass.employee"]);
  expect(mcp.scopes_supported).not.toContain("offline_access");
  const root = await (await prm.GET(new Request("https://x/api/oauth/meta/protected-resource?kind=root"))).json();
  expect(root.resource).toBe(ISSUER);
  const as = await (await asm.GET()).json();
  expect(as.issuer).toBe(mcp.authorization_servers[0]);
  expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
  expect(as.client_id_metadata_document_supported).toBe(true);
  expect(as.authorization_response_iss_parameter_supported).toBe(true);
  expect(as.registration_endpoint).toBeUndefined();
  process.env.MCP_OAUTH_DCR_ENABLED = "1";
  expect((await (await asm.GET()).json()).registration_endpoint).toBe(`${ISSUER}/api/oauth/register`);
});

test("issuer override trims trailing slash", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_OAUTH_ISSUER = "https://preview.example.com/";
  const as = await (await asm.GET()).json();
  expect(as.issuer).toBe("https://preview.example.com");
  expect(as.token_endpoint).toBe("https://preview.example.com/api/oauth/token");
});

test("next.config rewrites route .well-known/oauth-* to the handlers", async () => {
  const cfg = (await import("@/next.config")).default as { rewrites: () => Promise<Array<{ source: string; destination: string }>> };
  const rules = await cfg.rewrites();
  const map = Object.fromEntries(rules.map((r) => [r.source, r.destination]));
  expect(map["/.well-known/oauth-protected-resource/api/mcp"]).toBe("/api/oauth/meta/protected-resource?kind=mcp");
  expect(map["/.well-known/oauth-protected-resource"]).toBe("/api/oauth/meta/protected-resource?kind=root");
  expect(map["/.well-known/oauth-authorization-server"]).toBe("/api/oauth/meta/authorization-server");
});
