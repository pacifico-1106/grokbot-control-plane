import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { directory, freshStore, seedClientAndGrant } from "@/lib/mcp-oauth/__tests__/fixtures";
import { BADGE_AUTH_NEXT_STEP_JA } from "@/lib/mcp/badge-auth-attempt";

/** /api/mcp/employee — badge-only mouth. Flag OFF → 404. Never advertises OAuth. */
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
const GB = "gb_emp_employee_mouth_fixture";
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
const employee = await import("./route");
const { GET: sharedGet } = await import("../route");

let store = freshStore();
const ENV = [
  "MCP_OAUTH_ENABLED",
  "MCP_OAUTH_DCR_ENABLED",
  "MCP_OAUTH_ISSUER",
  "MCP_OAUTH_ORG_ALLOWLIST",
  "MCP_OAUTH_ORG_ALLOWLIST_REQUIRED",
  "MCP_EMPLOYEE_BADGE_MCP_ENABLED",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a";
  store = freshStore();
  __setOAuthStoreForTests(store);
  directory.reset();
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  __setOAuthStoreForTests(null);
});

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  employee.POST(
    new Request("https://staffpass.test/api/mcp/employee", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );

test("flag OFF: GET / POST / OPTIONS on /api/mcp/employee are 404", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  expect((await employee.GET()).status).toBe(404);
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(404);
  expect((await employee.OPTIONS()).status).toBe(404);
});

test("flag ON: GET card never includes oauth / resource_metadata; endpoint is the badge mouth", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const res = await employee.GET();
  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.auth.oauth).toBeUndefined();
  expect(card.mcpEndpoint).toContain("/api/mcp/employee");
  expect(JSON.stringify(card)).not.toContain("resource_metadata");
  expect(JSON.stringify(card)).not.toContain("oauth-protected-resource");
  const shared = await (await sharedGet()).json();
  expect(shared.auth.oauth).toBeDefined();
});

test("flag ON + OAuth ON: unauthenticated tools/list is 401 without WWW-Authenticate", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBeNull();
  expect(res.headers.get("access-control-expose-headers")).toBeNull();
  const body = await res.json();
  expect(body.error.data.nextStepJa).toBe(BADGE_AUTH_NEXT_STEP_JA);
  expect(body.error.data._meta?.["mcp/www_authenticate"]).toBeUndefined();
});

test("flag ON: initialize instructions stay badge-only (no OAuth sentence)", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.instructions).toContain("Authorization: Bearer gb_emp_");
  expect(body.result.instructions).not.toContain("OAuth");
});

test("flag ON: valid gb_emp_ lists tools; sp_at_ is refused without an OAuth challenge", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const ok = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { authorization: `Bearer ${GB}` });
  expect(ok.status).toBe(200);
  const { accessToken } = await seedClientAndGrant(store);
  const denied = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { authorization: `Bearer ${accessToken}` });
  expect(denied.status).toBe(401);
  expect(denied.headers.get("www-authenticate")).toBeNull();
  const body = await denied.json();
  expect(body.error.data.nextStepJa).toBe(BADGE_AUTH_NEXT_STEP_JA);
  expect(JSON.stringify(body)).not.toContain(accessToken);
});

test("next.config does not rewrite well-known PRM for /api/mcp/employee", async () => {
  const cfg = (await import("@/next.config")).default as { rewrites: () => Promise<Array<{ source: string; destination: string }>> };
  const rules = await cfg.rewrites();
  expect(rules.some((r) => r.source.includes("/api/mcp/employee"))).toBe(false);
  expect(rules.map((r) => r.source)).toContain("/.well-known/oauth-protected-resource/api/mcp");
});
