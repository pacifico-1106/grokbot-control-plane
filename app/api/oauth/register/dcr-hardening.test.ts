/**
 * #318 follow-up (木村 2026-10-10): DCR per-IP limit counts an IPv6 /64 as one
 * client; hitting the global daily cap alerts ops (once per day).
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const alerts: Array<Record<string, unknown>> = [];
const realNotify = await import("@/lib/mcp-oauth/notify");
mock.module("@/lib/mcp-oauth/notify", () => ({
  ...realNotify,
  notifyOpsDcrGlobalCapReached: async (n: Record<string, unknown>) => {
    alerts.push(n);
  },
}));
const { __setOAuthStoreForTests, createMemoryOAuthStore, getOAuthStore } = await import("@/lib/data/oauth");
const { OAUTH_RATE_LIMITS } = await import("@/lib/mcp-oauth/rate-limit");
const { POST } = await import("./route");

const ENV = ["MCP_OAUTH_ENABLED", "MCP_OAUTH_DCR_ENABLED", "IP_HASH_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  __setOAuthStoreForTests(createMemoryOAuthStore());
  alerts.length = 0;
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_OAUTH_DCR_ENABLED = "1";
  process.env.IP_HASH_KEY = "test-ip-hash-key-0123456789";
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  __setOAuthStoreForTests(null);
});
const good = { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" };
const reg = (ip: string) =>
  POST(new Request("https://staffpass.test/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(good) }));

test("IPv6: every address in one /64 shares the per-IP bucket; another /64 is separate", async () => {
  const limit = OAUTH_RATE_LIMITS.dcrPerIpPerHour;
  for (let i = 1; i <= limit; i++) expect((await reg(`2001:db8:1:2::${i.toString(16)}`)).status).toBe(201);
  // rotating the interface id inside the same /64 does not get a fresh bucket
  expect((await reg("2001:db8:1:2:ffff:ffff:ffff:fffe")).status).toBe(429);
  expect((await reg("2001:0db8:0001:0002:0:0:0:abcd")).status).toBe(429);
  // a different /64 is a different client
  expect((await reg("2001:db8:1:3::1")).status).toBe(201);
});

test("IPv4-mapped IPv6 and plain IPv4 are the same bucket", async () => {
  for (let i = 0; i < OAUTH_RATE_LIMITS.dcrPerIpPerHour; i++) expect((await reg("203.0.113.5")).status).toBe(201);
  expect((await reg("::ffff:203.0.113.5")).status).toBe(429);
});

test("global daily cap → 429 and ONE ops alert per day (not one per refused request)", async () => {
  const store = getOAuthStore();
  const now = new Date().toISOString();
  for (let i = 0; i < OAUTH_RATE_LIMITS.dcrGlobalPerDay; i++) {
    await store.upsertClient({
      clientId: `dcr_seed_${i}`, registrationType: "dcr", clientName: "x", clientUri: null, logoUri: null,
      redirectUris: [], tokenEndpointAuthMethod: "none", metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null,
      status: "active", createdIpHash: `seed${i}`, createdAt: now,
    });
  }
  expect((await reg("198.51.100.1")).status).toBe(429);
  expect((await reg("198.51.100.2")).status).toBe(429);
  expect((await reg("2001:db8:9::1")).status).toBe(429);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ cap: OAUTH_RATE_LIMITS.dcrGlobalPerDay });
  expect(Number(alerts[0].count)).toBeGreaterThanOrEqual(OAUTH_RATE_LIMITS.dcrGlobalPerDay);
  // ids / counts only — no IPs or hashes in the alert
  expect(JSON.stringify(alerts[0])).not.toMatch(/198\.51|2001:db8|seed/);
});

test("below the cap → no alert", async () => {
  expect((await reg("198.51.100.1")).status).toBe(201);
  expect(alerts).toHaveLength(0);
});
