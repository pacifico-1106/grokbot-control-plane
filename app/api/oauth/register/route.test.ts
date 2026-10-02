import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const { __setOAuthStoreForTests, createMemoryOAuthStore } = await import("@/lib/data/oauth");
const { POST } = await import("./route");

const ENV = ["MCP_OAUTH_ENABLED", "MCP_OAUTH_DCR_ENABLED", "IP_HASH_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  __setOAuthStoreForTests(createMemoryOAuthStore());
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  __setOAuthStoreForTests(null);
});
const on = () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_OAUTH_DCR_ENABLED = "1";
  process.env.IP_HASH_KEY = "test-ip-hash-key-0123456789";
};
const reg = (body: unknown, ip = "203.0.113.5") =>
  POST(new Request("https://staffpass.test/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));
const good = { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" };

test("404 unless both MCP_OAUTH_ENABLED and MCP_OAUTH_DCR_ENABLED", async () => {
  expect((await reg(good)).status).toBe(404);
  process.env.MCP_OAUTH_ENABLED = "1";
  expect((await reg(good)).status).toBe(404);
});

test("missing IP_HASH_KEY → 503 (fail closed)", async () => {
  on();
  delete process.env.IP_HASH_KEY;
  expect((await reg(good)).status).toBe(503);
});

test("registers a public client; response is no-store", async () => {
  on();
  const res = await reg(good);
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(String(body.client_id).startsWith("dcr_")).toBe(true);
  expect(body.token_endpoint_auth_method).toBe("none");
});

test("any non-allowlisted redirect / confidential client / bad grant → 400", async () => {
  on();
  expect((await reg({ ...good, redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"] })).status).toBe(400);
  expect((await reg({ ...good, token_endpoint_auth_method: "client_secret_basic" })).status).toBe(400);
  expect((await reg({ ...good, grant_types: ["client_credentials"] })).status).toBe(400);
  expect((await reg({ ...good, response_types: ["token"] })).status).toBe(400);
  expect((await reg({ client_name: "x" })).status).toBe(400);
});

test("per-IP limit 10/hour → 429 with Retry-After", async () => {
  on();
  for (let i = 0; i < 10; i++) expect((await reg(good)).status).toBe(201);
  const res = await reg(good);
  expect(res.status).toBe(429);
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await reg(good, "198.51.100.7")).status).toBe(201);
});
