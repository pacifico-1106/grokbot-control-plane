/** Production DCR 400 (2026-10-10): Cursor desktop registers its 3 callbacks together. */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const { __setOAuthStoreForTests, createMemoryOAuthStore } = await import("@/lib/data/oauth");
const { CURSOR_DESKTOP_NEAR_MISSES } = await import("@/lib/mcp-oauth/__tests__/cursor-fixtures");
const { POST } = await import("./route");

const ENV = ["MCP_OAUTH_ENABLED", "MCP_OAUTH_DCR_ENABLED", "IP_HASH_KEY", "MCP_OAUTH_REDIRECT_ALLOWLIST"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __setOAuthStoreForTests(createMemoryOAuthStore());
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_OAUTH_DCR_ENABLED = "1";
  process.env.IP_HASH_KEY = "test-ip-hash-key-0123456789";
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setOAuthStoreForTests(null);
});
let ip = 0;
const reg = (redirect_uris: string[]) =>
  POST(new Request("https://staffpass.test/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `198.51.100.${(ip++ % 200) + 1}` },
    body: JSON.stringify({ client_name: "Cursor", redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  }));
const CURSOR = ["cursor://anysphere.cursor-mcp/oauth/callback", "https://www.cursor.com/agents/mcp/oauth/callback", "http://localhost:8787/callback"];

test("Cursor desktop's exact DCR body (3 redirect_uris) → 201, all three echoed back", async () => {
  const res = await reg(CURSOR);
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.redirect_uris).toEqual(CURSOR);
  expect(String(body.client_id).startsWith("dcr_")).toBe(true);
});

test("cursor:// alone → 201", async () => {
  expect((await reg([CURSOR[0]])).status).toBe(201);
});

for (const bad of CURSOR_DESKTOP_NEAR_MISSES) {
  test(`near-miss with Cursor's two valid callbacks → whole registration 400: ${JSON.stringify(bad)}`, async () => {
    const res = await reg([bad, CURSOR[1], CURSOR[2]]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_redirect_uri");
  });
}
