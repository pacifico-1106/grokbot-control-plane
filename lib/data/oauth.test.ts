import { expect, test } from "bun:test";
import { createMemoryOAuthStore, getOAuthStore, __setOAuthStoreForTests } from "./oauth";

const NOW = "2026-10-03T00:00:00.000Z";
const LATER = "2026-10-03T00:20:00.000Z";
const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

async function seedGrant() {
  const store = createMemoryOAuthStore();
  await store.upsertClient({
    clientId: "https://claude.ai/oauth/client.json",
    registrationType: "cimd",
    clientName: "Claude",
    clientUri: null,
    logoUri: null,
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    tokenEndpointAuthMethod: "none",
    metadata: {},
    metadataFetchedAt: NOW,
    metadataExpiresAt: at(NOW, 3600_000),
    status: "active",
    createdIpHash: null,
  });
  const grant = await store.createGrant({
    orgId: "org_a",
    employeeId: "emp_1",
    clientId: "https://claude.ai/oauth/client.json",
    credentialIdAtGrant: "cred_1",
    grantedByMemberId: "mem_1",
    grantedByEmail: "owner@example.com",
    resource: "https://staffpass.sealith.com/api/mcp",
    scope: ["staffpass.employee"],
    expiresAt: at(NOW, 90 * 86400_000),
  });
  return { store, grant };
}

test("auth request is one-time and expires", async () => {
  const store = createMemoryOAuthStore();
  await store.createAuthRequest({
    id: "rid_1",
    clientId: "c",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    state: "s",
    codeChallenge: "x".repeat(43),
    resource: "r",
    scope: ["staffpass.employee"],
    expiresAt: at(NOW, 600_000),
  });
  expect((await store.consumeAuthRequest("rid_1", NOW)).ok).toBe(true);
  const again = await store.consumeAuthRequest("rid_1", NOW);
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.reason).toBe("already_consumed");
  await store.createAuthRequest({ id: "rid_2", clientId: "c", redirectUri: "u", state: null, codeChallenge: "c", resource: "r", scope: [], expiresAt: at(NOW, 600_000) });
  const late = await store.consumeAuthRequest("rid_2", LATER);
  expect(late.ok).toBe(false);
  if (!late.ok) expect(late.reason).toBe("expired");
  const missing = await store.consumeAuthRequest("nope", NOW);
  if (!missing.ok) expect(missing.reason).toBe("not_found");
});

test("code consume: once only; reuse reported with record (for grant revocation)", async () => {
  const { store, grant } = await seedGrant();
  await store.createCode({ codeHash: "h1", grantId: grant.id, clientId: grant.clientId, redirectUri: "u", codeChallenge: "c", resource: grant.resource, expiresAt: at(NOW, 60_000) });
  expect((await store.consumeCode("h1", NOW)).ok).toBe(true);
  const reuse = await store.consumeCode("h1", NOW);
  expect(reuse.ok).toBe(false);
  if (!reuse.ok) {
    expect(reuse.reason).toBe("already_consumed");
    expect(reuse.record?.grantId).toBe(grant.id);
  }
});

test("refresh rotation: concurrent second rotation fails; revoked cannot rotate", async () => {
  const { store, grant } = await seedGrant();
  await store.createRefreshToken({ tokenHash: "r1", grantId: grant.id, parentHash: null, expiresAt: at(NOW, 30 * 86400_000) });
  const [a, b] = await Promise.all([store.rotateRefreshToken("r1", NOW), store.rotateRefreshToken("r1", NOW)]);
  expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
  await store.createRefreshToken({ tokenHash: "r2", grantId: grant.id, parentHash: "r1", expiresAt: at(NOW, 30 * 86400_000) });
  await store.revokeTokensForGrant(grant.id, NOW);
  expect((await store.rotateRefreshToken("r2", NOW)).ok).toBe(false);
});

test("grant revocation: per grant and per employee; idempotent", async () => {
  const { store, grant } = await seedGrant();
  const g2 = await store.createGrant({ ...grant, credentialIdAtGrant: null });
  const revoked = await store.revokeGrant(grant.id, "admin@example.com", "manual", NOW);
  expect(revoked?.status).toBe("revoked");
  expect(revoked?.revokeReason).toBe("manual");
  const again = await store.revokeGrant(grant.id, "x@example.com", "other", LATER);
  expect(again?.revokedByEmail).toBe("admin@example.com");
  const bulk = await store.revokeGrantsForEmployee("org_a", "emp_1", "owner@example.com", "terminate", NOW);
  expect(bulk.map((g) => g.id)).toEqual([g2.id]);
  expect(await store.revokeGrantsForEmployee("org_b", "emp_1", "x", "y", NOW)).toEqual([]);
});

test("access token revoke and grant-wide revoke", async () => {
  const { store, grant } = await seedGrant();
  await store.createAccessToken({ tokenHash: "a1", grantId: grant.id, expiresAt: at(NOW, 3600_000) });
  await store.createAccessToken({ tokenHash: "a2", grantId: grant.id, expiresAt: at(NOW, 3600_000) });
  expect(await store.revokeAccessToken("a1", NOW)).toBe(true);
  expect(await store.revokeAccessToken("a1", NOW)).toBe(false);
  await store.revokeTokensForGrant(grant.id, NOW);
  expect((await store.getAccessToken("a2"))?.revokedAt).toBe(NOW);
});

test("rate limit counter is per bucket and window", async () => {
  const store = createMemoryOAuthStore();
  expect(await store.rateLimitHit("token:ip1", NOW)).toBe(1);
  expect(await store.rateLimitHit("token:ip1", NOW)).toBe(2);
  expect(await store.rateLimitHit("token:ip2", NOW)).toBe(1);
  expect(await store.rateLimitHit("token:ip1", LATER)).toBe(1);
});

test("DCR counting + stale cleanup only touch dcr clients", async () => {
  const store = createMemoryOAuthStore();
  const base = { clientName: "x", clientUri: null, logoUri: null, redirectUris: [], tokenEndpointAuthMethod: "none" as const, metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active" as const };
  await store.upsertClient({ ...base, clientId: "dcr_1", registrationType: "dcr", createdIpHash: "ipA", createdAt: NOW });
  await store.upsertClient({ ...base, clientId: "dcr_2", registrationType: "dcr", createdIpHash: "ipB", createdAt: NOW });
  await store.upsertClient({ ...base, clientId: "https://chatgpt.com/oauth/client.json", registrationType: "cimd", createdIpHash: null, createdAt: NOW });
  expect(await store.countDcrClientsSince(NOW)).toBe(2);
  expect(await store.countDcrClientsSince(NOW, "ipA")).toBe(1);
  expect(await store.deleteStaleDcrClients(LATER)).toBe(2);
  expect(await store.getClient("https://chatgpt.com/oauth/client.json")).not.toBeNull();
});

test("purgeExpired removes only expired rows", async () => {
  const { store, grant } = await seedGrant();
  await store.createAccessToken({ tokenHash: "old", grantId: grant.id, expiresAt: at(NOW, -1) });
  await store.createAccessToken({ tokenHash: "new", grantId: grant.id, expiresAt: at(NOW, 3600_000) });
  const res = await store.purgeExpired(NOW);
  expect(res.accessTokens).toBe(1);
  expect(await store.getAccessToken("new")).not.toBeNull();
});

test("selector: DEMO uses memory store; override wins", async () => {
  const s1 = getOAuthStore();
  expect(getOAuthStore()).toBe(s1);
  const mem = createMemoryOAuthStore();
  __setOAuthStoreForTests(mem);
  expect(getOAuthStore()).toBe(mem);
  __setOAuthStoreForTests(null);
});

test("migration file: RLS on every table, no policies, rollback kept out of migrations/", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const sql = readFileSync("supabase/migrations/20261010200000_mcp_oauth.sql", "utf8");
  const tables = [...sql.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
  expect(tables.length).toBe(7);
  for (const t of tables) expect(sql).toContain(`alter table ${t} enable row level security;`);
  expect(sql.toLowerCase()).not.toContain("create policy");
  expect(readdirSync("supabase/migrations").some((f) => f.includes("rollback"))).toBe(false);
  expect(readFileSync("supabase/verification/20261010200000_mcp_oauth_rollback.sql", "utf8")).toContain("drop table if exists oauth_grants");
});
