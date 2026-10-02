import { beforeEach, describe, expect, test } from "bun:test";
import { handleRevokeRequest, handleTokenRequest, s256, type TokenDeps } from "@/lib/mcp-oauth/token-endpoint";
import { mintAuthCode, sha256Hex } from "@/lib/mcp-oauth/tokens";
import { CLAUDE_CLIENT, RESOURCE, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";

const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-._~" + "A1b2C3d4E5f6G7h8I9j0K";
let store = freshStore();
let now = new Date("2026-10-03T00:00:00Z");
let audits: Array<{ action: string; metadata: Record<string, unknown> }>;
let notices: string[];
let rateAllowed = true;
let grantId = "";

function deps(over: Partial<TokenDeps> = {}): TokenDeps {
  return {
    store,
    now: () => now,
    audit: async (e) => {
      audits.push({ action: e.action, metadata: e.metadata });
    },
    notifySecurity: async (n) => {
      notices.push(n.kind);
    },
    rateLimit: async () => ({ allowed: rateAllowed, count: 1, retryAfterSec: 30 }),
    ipHash: () => "iphash",
    ...over,
  };
}

function form(body: Record<string, string>, ct = "application/x-www-form-urlencoded") {
  return new Request("https://staffpass.sealith.com/api/oauth/token", { method: "POST", headers: { "content-type": ct }, body: new URLSearchParams(body).toString() });
}

async function seed(grantExpiresAt?: string) {
  await store.upsertClient({
    clientId: CLAUDE_CLIENT, registrationType: "cimd", clientName: "Claude", clientUri: null, logoUri: null,
    redirectUris: [CB], tokenEndpointAuthMethod: "none", metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active", createdIpHash: null,
  });
  const g = await store.createGrant({
    orgId: "org_a", employeeId: "emp_1", clientId: CLAUDE_CLIENT, credentialIdAtGrant: "cred_1", grantedByMemberId: "mem_1", grantedByEmail: "o@x",
    resource: RESOURCE, scope: ["staffpass.employee", "offline_access"], expiresAt: grantExpiresAt ?? new Date(now.getTime() + 90 * 86400_000).toISOString(),
  });
  grantId = g.id;
  const code = mintAuthCode();
  await store.createCode({ codeHash: code.hash, grantId: g.id, clientId: CLAUDE_CLIENT, redirectUri: CB, codeChallenge: s256(VERIFIER), resource: RESOURCE, expiresAt: new Date(now.getTime() + 60_000).toISOString() });
  return code.raw;
}

const exchange = (code: string, over: Record<string, string> = {}) =>
  handleTokenRequest(form({ grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: VERIFIER, client_id: CLAUDE_CLIENT, resource: RESOURCE, ...over }), deps());
const refresh = (rt: string, over: Record<string, string> = {}) =>
  handleTokenRequest(form({ grant_type: "refresh_token", refresh_token: rt, client_id: CLAUDE_CLIENT, ...over }), deps());

beforeEach(() => {
  // Allowlist is fail-closed by default (MCP_OAUTH_ORG_ALLOWLIST_REQUIRED); pilot org = org_a.
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a";
  delete process.env.MCP_OAUTH_ORG_ALLOWLIST_REQUIRED;
  store = freshStore();
  now = new Date("2026-10-03T00:00:00Z");
  audits = [];
  notices = [];
  rateAllowed = true;
});

describe("POST /api/oauth/token — authorization_code", () => {
  test("happy path: Bearer access (1h) + refresh, scope, audit token_issued with hash prefixes only", async () => {
    const code = await seed();
    const r = await exchange(code);
    expect(r.status).toBe(200);
    const b = r.body as Record<string, string | number>;
    expect(String(b.access_token)).toMatch(/^sp_at_[A-Za-z0-9_-]{43}$/);
    expect(String(b.refresh_token)).toMatch(/^sp_rt_[A-Za-z0-9_-]{43}$/);
    expect(b.token_type).toBe("Bearer");
    expect(b.expires_in).toBe(3600);
    expect(b.scope).toBe("staffpass.employee offline_access");
    expect(await store.getAccessToken(sha256Hex(String(b.access_token)))).toBeTruthy();
    expect(audits.map((a) => a.action)).toEqual(["oauth.token_issued"]);
    const dump = JSON.stringify(audits);
    expect(dump).not.toContain(String(b.access_token));
    expect(dump).not.toContain(String(b.refresh_token));
    expect(dump).not.toContain(code);
  });

  test("code reuse → invalid_grant AND whole grant revoked (tokens from first exchange die)", async () => {
    const code = await seed();
    const first = await exchange(code);
    const at = String((first.body as Record<string, string>).access_token);
    const again = await exchange(code);
    expect(again).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await store.getGrant(grantId))?.status).toBe("revoked");
    expect((await store.getAccessToken(sha256Hex(at)))?.revokedAt).toBeTruthy();
    expect(audits.map((a) => a.action)).toContain("oauth.code_reuse_detected");
    expect(notices).toEqual(["code_reuse"]);
  });

  test("PKCE: wrong verifier, malformed verifier → invalid_grant / invalid_request", async () => {
    const code = await seed();
    expect(await exchange(code, { code_verifier: "w".repeat(43) })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    const code2 = await seed();
    expect(await exchange(code2, { code_verifier: "short" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });

  test("redirect_uri mismatch / other client / expired code → invalid_grant or invalid_client", async () => {
    expect(await exchange(await seed(), { redirect_uri: "http://localhost:1/callback" })).toMatchObject({ body: { error: "invalid_grant" } });
    expect(await exchange(await seed(), { client_id: "https://chatgpt.com/x.json" })).toMatchObject({ status: 401, body: { error: "invalid_client" } });
    const code = await seed();
    now = new Date(now.getTime() + 61_000);
    expect(await exchange(code)).toMatchObject({ body: { error: "invalid_grant" } });
  });

  test("resource mismatch → invalid_target; omitted resource OK", async () => {
    expect(await exchange(await seed(), { resource: "https://evil.example/api/mcp" })).toMatchObject({ body: { error: "invalid_target" } });
    const code = await seed();
    const r = await handleTokenRequest(form({ grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: VERIFIER, client_id: CLAUDE_CLIENT }), deps());
    expect(r.status).toBe(200);
  });

  test("revoked grant / org removed from allowlist → invalid_grant", async () => {
    const code = await seed();
    await store.revokeGrant(grantId, "o@x", "manual", now.toISOString());
    expect(await exchange(code)).toMatchObject({ body: { error: "invalid_grant" } });
    const code2 = await seed();
    process.env.MCP_OAUTH_ORG_ALLOWLIST = "92f3617c-33fc-4dac-b9b4-d4f42e8522ac";
    expect(await exchange(code2)).toMatchObject({ body: { error: "invalid_grant" } });
  });

  test("empty allowlist is fail-closed by default; only MCP_OAUTH_ORG_ALLOWLIST_REQUIRED=0 opens all orgs (hardening 8)", async () => {
    delete process.env.MCP_OAUTH_ORG_ALLOWLIST;
    expect(await exchange(await seed())).toMatchObject({ body: { error: "invalid_grant" } });
    process.env.MCP_OAUTH_ORG_ALLOWLIST = " , ";
    expect(await exchange(await seed())).toMatchObject({ body: { error: "invalid_grant" } });
    process.env.MCP_OAUTH_ORG_ALLOWLIST_REQUIRED = "0";
    expect((await exchange(await seed())).status).toBe(200);
  });

  test("token lifetimes are capped by grant expiry", async () => {
    const code = await seed(new Date(now.getTime() + 600_000).toISOString());
    const r = await exchange(code);
    expect((r.body as Record<string, number>).expires_in).toBe(600);
  });
});

describe("POST /api/oauth/token — validate before consuming the code (hardening 5)", () => {
  test("leaked code + wrong verifier → invalid_grant, code NOT burned, grant survives, owner can still exchange", async () => {
    const code = await seed();
    expect(await exchange(code, { code_verifier: "w".repeat(43) })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(await exchange(code, { code_verifier: "x".repeat(43) })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await store.getGrant(grantId))?.status).toBe("active");
    expect(audits.map((a) => a.action)).not.toContain("oauth.code_reuse_detected");
    expect(notices).toEqual([]);
    expect((await exchange(code)).status).toBe(200);
  });

  test("leaked code + wrong redirect_uri / other registered client → not consumed, no revocation", async () => {
    const code = await seed();
    expect(await exchange(code, { redirect_uri: "https://claude.ai/api/mcp/other" })).toMatchObject({ body: { error: "invalid_grant" } });
    await store.upsertClient({ clientId: "https://chatgpt.com/c.json", registrationType: "cimd", clientName: "ChatGPT", clientUri: null, logoUri: null, redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"], tokenEndpointAuthMethod: "none", metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active", createdIpHash: null });
    expect(await exchange(code, { client_id: "https://chatgpt.com/c.json" })).toMatchObject({ body: { error: "invalid_grant" } });
    expect((await store.getGrant(grantId))?.status).toBe("active");
    expect((await exchange(code)).status).toBe(200);
  });

  test("replay of a used code with a WRONG verifier does not revoke; genuine replay (correct verifier) still does", async () => {
    const code = await seed();
    expect((await exchange(code)).status).toBe(200);
    expect(await exchange(code, { code_verifier: "w".repeat(43) })).toMatchObject({ body: { error: "invalid_grant" } });
    expect((await store.getGrant(grantId))?.status).toBe("active");
    expect(await exchange(code)).toMatchObject({ body: { error: "invalid_grant" } });
    expect((await store.getGrant(grantId))?.status).toBe("revoked");
    expect(audits.map((a) => a.action)).toContain("oauth.code_reuse_detected");
  });
});

describe("POST /api/oauth/token — request hygiene", () => {
  test("JSON body, duplicate params, client_secret, unknown grant_type", async () => {
    const code = await seed();
    expect(await handleTokenRequest(form({ grant_type: "authorization_code" }, "application/json"), deps())).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    const dup = new Request("https://x/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=authorization_code&code=${code}&code=${code}&client_id=${encodeURIComponent(CLAUDE_CLIENT)}` });
    expect(await handleTokenRequest(dup, deps())).toMatchObject({ body: { error: "invalid_request" } });
    expect(await exchange(code, { client_secret: "x" })).toMatchObject({ status: 401 });
    expect(await handleTokenRequest(form({ grant_type: "password", client_id: CLAUDE_CLIENT }), deps())).toMatchObject({ body: { error: "unsupported_grant_type" } });
  });

  test("rate limited → 429 + Retry-After; missing IP_HASH_KEY → 503", async () => {
    await seed();
    rateAllowed = false;
    const r = await refresh("sp_rt_x");
    expect(r.status).toBe(429);
    expect(r.headers?.["Retry-After"]).toBe("30");
    rateAllowed = true;
    expect(await handleTokenRequest(form({ grant_type: "refresh_token", client_id: CLAUDE_CLIENT }), deps({ ipHash: () => null }))).toMatchObject({ status: 503 });
  });
});

describe("POST /api/oauth/token — refresh rotation", () => {
  async function pair() {
    const r = await exchange(await seed());
    return r.body as Record<string, string>;
  }

  test("rotation issues a new pair; old refresh no longer works", async () => {
    const p = await pair();
    const r2 = await refresh(p.refresh_token);
    expect(r2.status).toBe(200);
    const p2 = r2.body as Record<string, string>;
    expect(p2.refresh_token).not.toBe(p.refresh_token);
    expect((await store.getRefreshToken(sha256Hex(p2.refresh_token)))?.parentHash).toBe(sha256Hex(p.refresh_token));
    expect(audits.filter((a) => a.action === "oauth.token_issued").length).toBe(1);
  });

  test("reuse within 30s grace → invalid_grant only (grant survives)", async () => {
    const p = await pair();
    await refresh(p.refresh_token);
    now = new Date(now.getTime() + 10_000);
    expect(await refresh(p.refresh_token)).toMatchObject({ body: { error: "invalid_grant" } });
    expect((await store.getGrant(grantId))?.status).toBe("active");
    expect(notices).toEqual([]);
    // hardening 6: the in-grace replay is still audited (no revocation, no notice)
    const replay = audits.filter((a) => a.action === "oauth.refresh_replay_in_grace");
    expect(replay.length).toBe(1);
    expect(replay[0].metadata).toMatchObject({ grantId, clientHost: "claude.ai", ageSec: 10 });
    expect(String(replay[0].metadata.refreshHashPrefix)).toHaveLength(12);
    expect(JSON.stringify(audits)).not.toContain(p.refresh_token);
  });

  test("reuse after grace → grant + all tokens revoked, audit + owner notice", async () => {
    const p = await pair();
    const p2 = (await refresh(p.refresh_token)).body as Record<string, string>;
    now = new Date(now.getTime() + 31_000);
    expect(await refresh(p.refresh_token)).toMatchObject({ body: { error: "invalid_grant" } });
    expect((await store.getGrant(grantId))?.status).toBe("revoked");
    expect((await store.getRefreshToken(sha256Hex(p2.refresh_token)))?.revokedAt).toBeTruthy();
    expect((await store.getAccessToken(sha256Hex(p2.access_token)))?.revokedAt).toBeTruthy();
    expect(audits.map((a) => a.action)).toContain("oauth.refresh_reuse_detected");
    expect(notices).toEqual(["refresh_reuse"]);
    expect(await refresh(p2.refresh_token)).toMatchObject({ body: { error: "invalid_grant" } });
  });

  test("refresh by another client / with wider scope / unknown token", async () => {
    const p = await pair();
    await store.upsertClient({ clientId: "https://chatgpt.com/c.json", registrationType: "cimd", clientName: "ChatGPT", clientUri: null, logoUri: null, redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"], tokenEndpointAuthMethod: "none", metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active", createdIpHash: null });
    expect(await refresh(p.refresh_token, { client_id: "https://chatgpt.com/c.json" })).toMatchObject({ body: { error: "invalid_grant" } });
    expect(await refresh(p.refresh_token, { scope: "staffpass.admin" })).toMatchObject({ body: { error: "invalid_scope" } });
    expect(await refresh("sp_rt_unknown")).toMatchObject({ body: { error: "invalid_grant" } });
  });

  test("refresh after grant revoked → invalid_grant", async () => {
    const p = await pair();
    await store.revokeGrant(grantId, "o@x", "manual", now.toISOString());
    expect(await refresh(p.refresh_token)).toMatchObject({ body: { error: "invalid_grant" } });
  });
});

describe("POST /api/oauth/revoke (RFC 7009)", () => {
  const revoke = (token: string, clientId = CLAUDE_CLIENT) =>
    handleRevokeRequest(form({ token, client_id: clientId }), deps());

  test("refresh token → grant + tokens revoked, audit grant_revoked; 200 empty", async () => {
    const p = (await exchange(await seed())).body as Record<string, string>;
    const r = await revoke(p.refresh_token);
    expect(r).toEqual({ status: 200, body: null });
    expect((await store.getGrant(grantId))?.status).toBe("revoked");
    expect((await store.getAccessToken(sha256Hex(p.access_token)))?.revokedAt).toBeTruthy();
    expect(audits.map((a) => a.action)).toContain("oauth.grant_revoked");
  });

  test("access token → only that token revoked", async () => {
    const p = (await exchange(await seed())).body as Record<string, string>;
    expect((await revoke(p.access_token)).status).toBe(200);
    expect((await store.getAccessToken(sha256Hex(p.access_token)))?.revokedAt).toBeTruthy();
    expect((await store.getGrant(grantId))?.status).toBe("active");
  });

  test("unknown token → 200; another client's token → 200 but untouched", async () => {
    const p = (await exchange(await seed())).body as Record<string, string>;
    expect((await revoke("sp_rt_nope")).status).toBe(200);
    await store.upsertClient({ clientId: "https://chatgpt.com/c.json", registrationType: "cimd", clientName: "ChatGPT", clientUri: null, logoUri: null, redirectUris: [], tokenEndpointAuthMethod: "none", metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active", createdIpHash: null });
    expect((await revoke(p.refresh_token, "https://chatgpt.com/c.json")).status).toBe(200);
    expect((await store.getGrant(grantId))?.status).toBe("active");
  });
});
