/**
 * #318 follow-up: /api/oauth/token and /api/oauth/revoke get an IP-only limit
 * checked BEFORE the client lookup, so rotating client_id neither bypasses the
 * limit nor creates a new rate-limit row per made-up client_id. Successful
 * token responses touch the client (last_used_at) for stale-DCR cleanup.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleRevokeRequest, handleTokenRequest, s256, type TokenDeps } from "@/lib/mcp-oauth/token-endpoint";
import { OAUTH_RATE_LIMITS } from "@/lib/mcp-oauth/rate-limit";
import { mintAuthCode } from "@/lib/mcp-oauth/tokens";
import { CLAUDE_CLIENT, RESOURCE, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";

const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-._~" + "A1b2C3d4E5f6G7h8I9j0K";
let store = freshStore();
let now = new Date("2026-10-10T00:00:00Z");
let buckets: Map<string, number>;

function deps(): TokenDeps {
  return {
    store,
    now: () => now,
    audit: async () => undefined,
    notifySecurity: async () => undefined,
    rateLimit: async (bucket, limit) => {
      const n = (buckets.get(bucket) ?? 0) + 1;
      buckets.set(bucket, n);
      return { allowed: n <= limit, count: n, retryAfterSec: 30 };
    },
    ipHash: () => "iphash",
  };
}
const post = (path: string, body: Record<string, string>) =>
  new Request(`https://staffpass.sealith.com${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

beforeEach(() => {
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a";
  delete process.env.MCP_OAUTH_ORG_ALLOWLIST_REQUIRED;
  store = freshStore();
  buckets = new Map();
  now = new Date("2026-10-10T00:00:00Z");
});

async function seedClientAndCode() {
  await store.upsertClient({
    clientId: CLAUDE_CLIENT, registrationType: "cimd", clientName: "Claude", clientUri: null, logoUri: null, redirectUris: [CB],
    tokenEndpointAuthMethod: "none", metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active", createdIpHash: null,
  });
  const grant = await store.createGrant({
    orgId: "org_a", employeeId: "emp_1", clientId: CLAUDE_CLIENT, credentialIdAtGrant: "cred_1", grantedByMemberId: "mem_1",
    grantedByEmail: "owner@example.com", resource: RESOURCE, scope: ["staffpass.employee"], expiresAt: new Date(now.getTime() + 86400_000).toISOString(),
  });
  const code = mintAuthCode();
  await store.createCode({ codeHash: code.hash, grantId: grant.id, clientId: CLAUDE_CLIENT, redirectUri: CB, codeChallenge: s256(VERIFIER), resource: RESOURCE, expiresAt: new Date(now.getTime() + 60_000).toISOString() });
  return code.raw;
}

describe("IP-only limit on token / revoke", () => {
  test("token: rotating client_id does not bypass the per-IP limit", async () => {
    const limit = OAUTH_RATE_LIMITS.tokenPerIpPerMin;
    let last = 0;
    for (let i = 0; i <= limit; i++) {
      last = (await handleTokenRequest(post("/api/oauth/token", { grant_type: "authorization_code", client_id: `dcr_fake_${i}`, code: "x", code_verifier: VERIFIER }), deps())).status;
    }
    expect(last).toBe(429);
  });
  test("token: unknown client_ids create no per-client rate-limit rows (bounded rows)", async () => {
    for (let i = 0; i < 50; i++) {
      await handleTokenRequest(post("/api/oauth/token", { grant_type: "authorization_code", client_id: `dcr_fake_${i}`, code: "x", code_verifier: VERIFIER }), deps());
    }
    expect([...buckets.keys()]).toHaveLength(1);
  });
  test("revoke: rotating client_id does not bypass the per-IP limit, and creates no per-client rows", async () => {
    const limit = OAUTH_RATE_LIMITS.revokePerIpPerMin;
    let last = 0;
    for (let i = 0; i <= limit; i++) {
      last = (await handleRevokeRequest(post("/api/oauth/revoke", { client_id: `dcr_fake_${i}`, token: "sp_at_x" }), deps())).status;
    }
    expect(last).toBe(429);
    expect([...buckets.keys()]).toHaveLength(1);
  });
  test("a known client still gets its own per-client+IP bucket as well", async () => {
    const raw = await seedClientAndCode();
    const r = await handleTokenRequest(post("/api/oauth/token", { grant_type: "authorization_code", client_id: CLAUDE_CLIENT, code: raw, code_verifier: VERIFIER, redirect_uri: CB, resource: RESOURCE }), deps());
    expect(r.status).toBe(200);
    expect([...buckets.keys()]).toHaveLength(2);
  });
});

describe("touchClient on successful token responses", () => {
  test("code exchange and refresh both set last_used_at; a failed request does not", async () => {
    const raw = await seedClientAndCode();
    expect((await store.getClient(CLAUDE_CLIENT))?.lastUsedAt).toBeNull();
    await handleTokenRequest(post("/api/oauth/token", { grant_type: "authorization_code", client_id: CLAUDE_CLIENT, code: "wrong", code_verifier: VERIFIER, redirect_uri: CB }), deps());
    expect((await store.getClient(CLAUDE_CLIENT))?.lastUsedAt).toBeNull();
    const r = await handleTokenRequest(post("/api/oauth/token", { grant_type: "authorization_code", client_id: CLAUDE_CLIENT, code: raw, code_verifier: VERIFIER, redirect_uri: CB, resource: RESOURCE }), deps());
    expect(r.status).toBe(200);
    expect((await store.getClient(CLAUDE_CLIENT))?.lastUsedAt).toBe(now.toISOString());
    now = new Date(now.getTime() + 3600_000);
    const rt = String((r.body as Record<string, unknown>).refresh_token);
    const r2 = await handleTokenRequest(post("/api/oauth/token", { grant_type: "refresh_token", client_id: CLAUDE_CLIENT, refresh_token: rt }), deps());
    expect(r2.status).toBe(200);
    expect((await store.getClient(CLAUDE_CLIENT))?.lastUsedAt).toBe(now.toISOString());
  });
});
