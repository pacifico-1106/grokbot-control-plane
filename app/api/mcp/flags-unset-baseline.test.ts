import { afterEach, beforeEach, expect, mock, test } from "bun:test";

/**
 * Pin (木村 2026-10-10): with every MCP OAuth flag UNSET, /api/mcp behaves
 * exactly as main did before the OAuth stack landed — unauthenticated
 * initialize 200 (no challenge), ping 200, notifications 202,
 * server/discover 200, tools/list 401 with the old body and no
 * WWW-Authenticate, no Access-Control-Expose-Headers, GET card without oauth,
 * and no staffpass_profile tool. Also passes unchanged on main 89b8769.
 * Runs in production mode (not DEMO) so the OAuth gate would be live if a flag
 * leaked on.
 */
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: () => null,
  resolveEmployeeCredential: async (r: Request) => {
    const raw = /^Bearer\s+(.+)$/i.exec(r.headers.get("authorization") || "")?.[1];
    return { ok: false, code: raw ? "invalid_credential" : "missing_credential", message: raw ? "invalid credential" : "missing credential", httpStatus: 401 };
  },
}));
const { GET, POST } = await import("./route");

const FLAGS = [
  "MCP_OAUTH_ENABLED",
  "MCP_OAUTH_DCR_ENABLED",
  "MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE",
  "MCP_OAUTH_ISSUER",
  "MCP_OAUTH_ORG_ALLOWLIST",
  "MCP_OAUTH_ORG_ALLOWLIST_REQUIRED",
  "MCP_OAUTH_CONSENT_REQUIRE_MFA",
  "MCP_OAUTH_REDIRECT_ALLOWLIST",
  "MCP_OAUTH_CIMD_ALLOWED_HOSTS",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of FLAGS) (saved[k] = process.env[k]), delete process.env[k];
});
afterEach(() => {
  for (const k of FLAGS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("https://staffpass.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

test("all flags unset: unauthenticated initialize → 200, no challenge, no expose header", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Cursor", version: "1.0.0" } } });
  expect(res.status).toBe(200);
  expect(res.headers.get("www-authenticate")).toBeNull();
  expect(res.headers.get("access-control-expose-headers")).toBeNull();
  const body = await res.json();
  expect(body.result.protocolVersion).toBe("2025-11-25");
  expect(body.result.instructions).toContain("Authenticate with Authorization: Bearer gb_emp_….");
  expect(JSON.stringify(body)).not.toContain("OAuth");
});

test("all flags unset: unauthenticated ping 200, notifications 202, server/discover 200", async () => {
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  expect((await rpc({ jsonrpc: "2.0", id: 2, method: "server/discover" })).status).toBe(200);
});

test("all flags unset: unauthenticated tools/list → 401 with the old body, no WWW-Authenticate", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBeNull();
  expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32001, message: "missing credential", data: { code: "missing_credential" } } });
});

test("all flags unset: bad Bearer on tools/call → 401 old body, no challenge", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "staffpass_whoami" } }, { authorization: "Bearer sp_at_whatever" });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBeNull();
  expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32001, message: "invalid credential", data: { code: "invalid_credential" } } });
});

test("all flags unset: GET server card has no oauth block and no staffpass_profile", async () => {
  const card = await (await GET()).json();
  expect(card.auth).toEqual({ type: "bearer", scheme: "Authorization: Bearer gb_emp_…", alternateHeader: "x-staffpass-credential" });
  expect(card.tools).not.toContain("staffpass_profile");
});
