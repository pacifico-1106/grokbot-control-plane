/** #318 follow-up: the daily OAuth purge cron also deletes stale DCR clients (never consented). */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const { __setOAuthStoreForTests, createMemoryOAuthStore } = await import("@/lib/data/oauth");
const { GET } = await import("./route");

const ENV = ["MCP_OAUTH_ENABLED", "CRON_SECRET"];
const saved: Record<string, string | undefined> = {};
let store = createMemoryOAuthStore();
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  store = createMemoryOAuthStore();
  __setOAuthStoreForTests(store);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setOAuthStoreForTests(null);
});
const call = () => GET(new Request("https://staffpass.test/api/cron/oauth-purge", { headers: { authorization: "Bearer cron-secret-0123456789" } }));
const base = { clientName: "x", clientUri: null, logoUri: null, redirectUris: [], tokenEndpointAuthMethod: "none" as const, metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active" as const, createdIpHash: "h" };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("deletes DCR clients older than a day with no grant; keeps fresh ones, consented ones and CIMD", async () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.CRON_SECRET = "cron-secret-0123456789";
  await store.upsertClient({ ...base, clientId: "dcr_stale", registrationType: "dcr", createdAt: ago(2 * 86400_000) });
  await store.upsertClient({ ...base, clientId: "dcr_fresh", registrationType: "dcr", createdAt: ago(3600_000) });
  await store.upsertClient({ ...base, clientId: "dcr_consented", registrationType: "dcr", createdAt: ago(40 * 86400_000) });
  await store.createGrant({ orgId: "org_a", employeeId: "emp_1", clientId: "dcr_consented", credentialIdAtGrant: null, grantedByMemberId: null, grantedByEmail: "o@example.com", resource: "r", scope: [], expiresAt: ago(-86400_000) });
  await store.upsertClient({ ...base, clientId: "https://claude.ai/c.json", registrationType: "cimd", createdIpHash: null, createdAt: ago(40 * 86400_000) });
  const res = await call();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.staleDcrClients).toBe(1);
  expect(await store.getClient("dcr_stale")).toBeNull();
  expect(await store.getClient("dcr_fresh")).not.toBeNull();
  expect(await store.getClient("dcr_consented")).not.toBeNull();
  expect(await store.getClient("https://claude.ai/c.json")).not.toBeNull();
});

test("OAuth OFF → skipped, nothing deleted", async () => {
  process.env.CRON_SECRET = "cron-secret-0123456789";
  await store.upsertClient({ ...base, clientId: "dcr_stale", registrationType: "dcr", createdAt: ago(2 * 86400_000) });
  const body = await (await call()).json();
  expect(body.skipped).toBe("oauth_disabled");
  expect(await store.getClient("dcr_stale")).not.toBeNull();
});
