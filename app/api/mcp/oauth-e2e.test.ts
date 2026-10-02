import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { CLAUDE_CLIENT, ISSUER, RESOURCE, directory, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";
import type { Employee, OrgMember } from "@/lib/types";

/**
 * PR-10 E2E (route handlers end to end, in-memory store, no network):
 * /oauth/authorize → /api/oauth/consent → /api/oauth/token → /api/mcp (sp_at_)
 * → refresh rotation → reuse detection → revoke. Plus negative paths.
 */
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
const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
const actualAudit = await import("@/lib/data/audit");
mock.module("@/lib/data/audit", () => ({
  ...actualAudit,
  appendAuditEvent: async (e: { action: string; metadata: Record<string, unknown> }) => {
    audits.push({ action: e.action, metadata: e.metadata });
  },
}));
mock.module("@/lib/mcp-oauth/employee-state", () => ({
  getCurrentEmployeeCredential: async (id: string) => directory.credentials.get(id) ?? null,
}));
mock.module("@/lib/mcp-oauth/org-info", () => ({ getOrgName: async () => "TOKYO307", getSessionAal: async () => "aal1" }));
const securityNotices: string[] = [];
mock.module("@/lib/mcp-oauth/notify", () => ({
  notifyOAuthConnected: async () => {},
  notifyOAuthSecurityEvent: async (n: { kind: string }) => {
    securityNotices.push(n.kind);
  },
  oauthConnectedEmail: () => ({ subject: "", html: "", text: "" }),
}));
const CB = "https://claude.ai/api/mcp/auth_callback";
mock.module("@/lib/mcp-oauth/clients", () => ({
  // Stands in for the CIMD fetch (no network): upserts like the real lookup does.
  lookupOAuthClient: async (clientId: string) => {
    if (clientId !== CLAUDE_CLIENT) return { ok: false, error: "cimd_fetch_failed" };
    const rec = {
      clientId, registrationType: "cimd" as const, clientName: "Claude", clientUri: null, logoUri: null, redirectUris: [CB],
      tokenEndpointAuthMethod: "none" as const, metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active" as const,
      createdIpHash: null,
    };
    await store.upsertClient(rec);
    return { ok: true, client: (await store.getClient(clientId))! };
  },
}));
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: () => null,
  resolveEmployeeCredential: async () => ({ ok: false, code: "invalid_credential", message: "nope", httpStatus: 401 }),
}));

const { __setOAuthStoreForTests } = await import("@/lib/data/oauth");
const { __setConsentDepsForTests } = await import("@/lib/mcp-oauth/consent");
const { mintConsentCsrf } = await import("@/lib/mcp-oauth/csrf");
const { s256 } = await import("@/lib/mcp-oauth/token-endpoint");
const authorizeRoute = await import("@/app/oauth/authorize/route");
const consentRoute = await import("@/app/api/oauth/consent/route");
const tokenRoute = await import("@/app/api/oauth/token/route");
const revokeRoute = await import("@/app/api/oauth/revoke/route");
const mcp = await import("./route");
const mcpAdmin = await import("./admin/route");

const SECRET = "e2e-state-secret-".padEnd(40, "x");
const VERIFIER = "e2e_verifier_" + "Z".repeat(40);
const owner = { id: "mem_1", orgId: "org_a", userId: "user_1", email: "owner@tokyo307.example", displayName: "Owner", role: "owner", status: "active", capabilities: ["hire_issue_credentials"] } as unknown as OrgMember;
const emp = { id: "emp_1", orgId: "org_a", displayName: "営業AI", roleLabel: "営業アシスタント", status: "active", scopes: ["mail:draft"], allowedPurposes: ["sales"] } as unknown as Employee;

let store = freshStore();
const ENV = ["MCP_OAUTH_ENABLED", "MCP_OAUTH_ORG_ALLOWLIST", "MCP_OAUTH_ISSUER", "IP_HASH_KEY", "MCP_PROTOCOL_NEGOTIATION_ENABLED", "MCP_PROTOCOL_MODERN_ENABLED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a";
  process.env.IP_HASH_KEY = "dummy-ip-hash-key-for-tests";
  store = freshStore();
  __setOAuthStoreForTests(store);
  directory.reset();
  audits.length = 0;
  securityNotices.length = 0;
  __setConsentDepsForTests({
    store,
    getSession: async () => ({ userId: "user_1", email: owner.email, orgId: "org_a", member: owner, lastSignInAt: new Date(Date.now() - 60_000).toISOString() }),
    getEmployeeById: async (id) => (id === "emp_1" ? emp : null),
    listEmployees: async (orgId) => (orgId === "org_a" ? [emp] : []),
    getBinding: async () => ({ status: "linked" }),
    getCurrentCredential: async () => ({ credentialId: "cred_1", expiresAt: null }),
    getOrgName: async () => "TOKYO307",
    getAal: async () => "aal1",
    audit: async (e) => {
      audits.push({ action: e.action, metadata: e.metadata });
    },
    notify: async () => {},
    rateLimit: async () => ({ allowed: true, count: 1, retryAfterSec: 60 }),
    stateSecret: () => SECRET,
    now: () => new Date(),
  });
});
afterEach(() => {
  setSystemTime();
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
afterAll(() => {
  __setOAuthStoreForTests(null);
  __setConsentDepsForTests(null);
});

async function authorize(over: Record<string, string> = {}) {
  const u = new URL(`${ISSUER}/oauth/authorize`);
  const q = { client_id: CLAUDE_CLIENT, redirect_uri: CB, response_type: "code", code_challenge: s256(VERIFIER), code_challenge_method: "S256", resource: RESOURCE, scope: "staffpass.employee offline_access", state: "st_e2e", ...over };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return authorizeRoute.GET(new Request(u, { headers: { "x-forwarded-for": "203.0.113.7" } }));
}
async function consent(rid: string, over: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const body = new URLSearchParams({ rid, csrf: mintConsentCsrf(SECRET, rid, "user_1", new Date()), decision: "allow", employee_id: "emp_1", confirm: "yes", ...over });
  return consentRoute.POST(new Request(`${ISSUER}/api/oauth/consent`, { method: "POST", headers: { origin: ISSUER, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...headers }, body }));
}
const tokenReq = (params: Record<string, string>) =>
  tokenRoute.POST(new Request(`${ISSUER}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7" }, body: new URLSearchParams(params) }));
const mcpCall = (token: string, method: string, params: Record<string, unknown> = {}, handler = mcp.POST, url = `${ISSUER}/api/mcp`) =>
  handler(new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));

async function fullFlow() {
  const a = await authorize();
  expect(a.status).toBe(303);
  const rid = new URL(a.headers.get("location")!).searchParams.get("rid")!;
  const c = await consent(rid);
  expect(c.status).toBe(303);
  const cb = new URL(c.headers.get("location")!);
  expect(cb.origin + cb.pathname).toBe(CB);
  expect(cb.searchParams.get("state")).toBe("st_e2e");
  expect(cb.searchParams.get("iss")).toBe(ISSUER);
  const code = cb.searchParams.get("code")!;
  const t = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: VERIFIER, client_id: CLAUDE_CLIENT, resource: RESOURCE });
  expect(t.status).toBe(200);
  expect(t.headers.get("cache-control")).toContain("no-store");
  const tok = (await t.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
  return { code, tok, rid };
}

test("E2E happy path: authorize → consent → token → /api/mcp tools/list + staffpass_profile", async () => {
  const { tok } = await fullFlow();
  expect(tok.access_token).toMatch(/^sp_at_/);
  expect(tok.refresh_token).toMatch(/^sp_rt_/);
  expect(tok.token_type).toBe("Bearer");
  const list = await mcpCall(tok.access_token, "tools/list");
  expect(list.status).toBe(200);
  const tools = (await list.json()).result.tools as Array<{ name: string; securitySchemes?: unknown }>;
  expect(tools.map((t) => t.name)).toContain("staffpass_profile");
  const prof = (await (await mcpCall(tok.access_token, "tools/call", { name: "staffpass_profile", arguments: {} })).json()).result;
  expect(prof.structuredContent).toMatchObject({ displayName: "営業AI", org: { name: "TOKYO307" }, authMethod: "oauth" });
  const acts = audits.map((a) => a.action);
  expect(acts).toContain("oauth.consent_granted");
  expect(acts).toContain("oauth.token_issued");
  expect(JSON.stringify(audits)).not.toContain(tok.access_token);
  expect(JSON.stringify(audits)).not.toContain(tok.refresh_token);
});

test("E2E modern era: same sp_at_ works on a 2026-07-28 stateless tools/list", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  process.env.MCP_PROTOCOL_MODERN_ENABLED = "1";
  const { tok } = await fullFlow();
  const res = await mcp.POST(
    new Request(`${ISSUER}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token}`, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    })
  );
  expect(res.status).toBe(200);
  expect((await res.json()).result.resultType).toBe("complete");
});

test("E2E refresh rotation → old refresh reuse revokes the whole grant (AT dies at /api/mcp)", async () => {
  const { tok } = await fullFlow();
  const r1 = await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLAUDE_CLIENT });
  expect(r1.status).toBe(200);
  const t2 = await r1.json();
  expect(t2.refresh_token).not.toBe(tok.refresh_token);
  expect((await mcpCall(t2.access_token, "tools/list")).status).toBe(200);
  // Within the 30s client-retry grace a replay is refused but does not nuke the grant.
  expect((await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLAUDE_CLIENT })).status).toBe(400);
  expect((await mcpCall(t2.access_token, "tools/list")).status).toBe(200);
  setSystemTime(new Date(Date.now() + 31_000));
  const reuse = await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLAUDE_CLIENT });
  expect(reuse.status).toBe(400);
  expect((await reuse.json()).error).toBe("invalid_grant");
  expect(securityNotices).toContain("refresh_reuse");
  expect((await mcpCall(t2.access_token, "tools/list")).status).toBe(401);
  expect((await tokenReq({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: CLAUDE_CLIENT })).status).toBe(400);
});

test("E2E code replay → invalid_grant and tokens from the first exchange are revoked", async () => {
  const { code, tok } = await fullFlow();
  const replay = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: VERIFIER, client_id: CLAUDE_CLIENT, resource: RESOURCE });
  expect(replay.status).toBe(400);
  expect((await mcpCall(tok.access_token, "tools/list")).status).toBe(401);
});

test("E2E revoke (RFC 7009) → AT 401 at /api/mcp with invalid_token challenge", async () => {
  const { tok } = await fullFlow();
  const rv = await revokeRoute.POST(new Request(`${ISSUER}/api/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7" }, body: new URLSearchParams({ token: tok.refresh_token, client_id: CLAUDE_CLIENT }) }));
  expect(rv.status).toBe(200);
  const after = await mcpCall(tok.access_token, "tools/list");
  expect(after.status).toBe(401);
  expect(after.headers.get("www-authenticate") || "").toContain('error="invalid_token"');
});

test("negative: wrong PKCE verifier / wrong redirect_uri / wrong resource at token → no tokens", async () => {
  for (const over of [{ code_verifier: "w".repeat(50) }, { redirect_uri: "https://claude.ai/other" }, { resource: `${ISSUER}/api/mcp/admin` }]) {
    const a = await authorize();
    const rid = new URL(a.headers.get("location")!).searchParams.get("rid")!;
    const code = new URL((await consent(rid)).headers.get("location")!).searchParams.get("code")!;
    const t = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: VERIFIER, client_id: CLAUDE_CLIENT, resource: RESOURCE, ...over });
    expect(t.status).toBe(400);
    expect(JSON.stringify(await t.json())).not.toContain("sp_at_");
  }
});

test("negative: authorize rejects plain PKCE, unknown client, unregistered redirect (no redirect to attacker)", async () => {
  const plain = await authorize({ code_challenge_method: "plain" });
  expect([302, 303]).toContain(plain.status); // error goes back to the *registered* redirect only
  expect(new URL(plain.headers.get("location")!).origin).toBe("https://claude.ai");
  const unknown = await authorize({ client_id: "https://evil.example/client.json" });
  expect(unknown.status).toBe(400);
  expect(unknown.headers.get("location")).toBeNull();
  const badRedirect = await authorize({ redirect_uri: "https://evil.example/cb" });
  expect(badRedirect.status).toBe(400);
  expect(badRedirect.headers.get("location")).toBeNull();
});

test("negative: consent cross-site POST / employee of other org / denied → no code", async () => {
  const a = await authorize();
  const rid = new URL(a.headers.get("location")!).searchParams.get("rid")!;
  expect((await consent(rid, {}, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await consent(rid, { employee_id: "emp_x" })).status).toBe(403);
  const deny = await consent(rid, { decision: "deny" });
  expect(deny.status).toBe(303);
  const loc = new URL(deny.headers.get("location")!);
  expect(loc.searchParams.get("error")).toBe("access_denied");
  expect(loc.searchParams.get("code")).toBeNull();
});

test("negative: sp_at_ never works on admin MCP; flag OFF kills every OAuth endpoint (404) and sp_at_", async () => {
  const { tok } = await fullFlow();
  expect((await mcpCall(tok.access_token, "tools/list", {}, mcpAdmin.POST, `${ISSUER}/api/mcp/admin`)).status).toBe(401);
  delete process.env.MCP_OAUTH_ENABLED;
  expect((await authorize()).status).toBe(404);
  expect((await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLAUDE_CLIENT })).status).toBe(404);
  expect((await mcpCall(tok.access_token, "tools/list")).status).toBe(401);
});

test("credential lifecycle: rotation keeps OAuth (Q3 default); revoked / expired credential or suspended employee → 401/403", async () => {
  const { tok } = await fullFlow();
  directory.credentials.set("emp_1", { credentialId: "cred_2", expiresAt: null });
  expect((await mcpCall(tok.access_token, "tools/list")).status).toBe(200);
  directory.credentials.set("emp_1", { credentialId: "cred_2", expiresAt: new Date(Date.now() - 1000).toISOString() });
  expect((await mcpCall(tok.access_token, "tools/list")).status).toBe(401);
  directory.credentials.set("emp_1", null);
  expect((await mcpCall(tok.access_token, "tools/list")).status).toBe(401);
  directory.reset();
  directory.employees.set("emp_1", { ...directory.employees.get("emp_1")!, status: "suspended" });
  expect((await mcpCall(tok.access_token, "tools/list")).status).toBe(401);
  directory.reset();
  directory.bindings.set("emp_1", { ...directory.bindings.get("emp_1")!, status: "revoked" });
  expect((await mcpCall(tok.access_token, "tools/list")).status).toBe(403);
});
