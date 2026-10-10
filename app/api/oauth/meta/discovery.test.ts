import { afterEach, beforeEach, expect, mock, test } from "bun:test";

/** PR-1 discovery: RFC 9728 PRM + RFC 8414 AS metadata (flag MCP_OAUTH_ENABLED, default OFF). */
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const prm = await import("./protected-resource/route");
const asm = await import("./authorization-server/route");

const ISSUER = "https://staffpass.sealith.com";
const ENV = ["MCP_OAUTH_ENABLED", "MCP_OAUTH_DCR_ENABLED", "MCP_OAUTH_ISSUER"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
const prmGet = (kind: string) => prm.GET(new Request(`https://x/api/oauth/meta/protected-resource?kind=${kind}`));

test("flag OFF (default): PRM (mcp + root) and AS metadata are 404", async () => {
  expect((await prmGet("mcp")).status).toBe(404);
  expect((await prmGet("root")).status).toBe(404);
  expect((await asm.GET()).status).toBe(404);
});

test("flag ON: PRM (mcp + root) and AS metadata shapes; issuer matches exactly; S256 only", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  const mcp = await (await prmGet("mcp")).json();
  expect(mcp.resource).toBe(`${ISSUER}/api/mcp`);
  expect(mcp.authorization_servers).toEqual([ISSUER]);
  expect(mcp.scopes_supported).toEqual(["staffpass.employee"]);
  expect(mcp.scopes_supported).not.toContain("offline_access");
  const root = await (await prmGet("root")).json();
  expect(root.resource).toBe(ISSUER);
  const as = await (await asm.GET()).json();
  expect(as.issuer).toBe(mcp.authorization_servers[0]);
  expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
  expect(as.client_id_metadata_document_supported).toBe(true);
  expect(as.authorization_response_iss_parameter_supported).toBe(true);
  expect(as.registration_endpoint).toBeUndefined();
});

test("DCR flag alone does nothing; with MCP_OAUTH_ENABLED it advertises registration_endpoint", async () => {
  process.env.MCP_OAUTH_DCR_ENABLED = "1";
  expect((await asm.GET()).status).toBe(404);
  process.env.MCP_OAUTH_ENABLED = "1";
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
