import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRevokeRequest, handleTokenRequest, s256, type TokenDeps } from "@/lib/mcp-oauth/token-endpoint";
import { mintAuthCode, sha256Hex } from "@/lib/mcp-oauth/tokens";
import { CLAUDE_CLIENT, RESOURCE, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";
import { __setHoldReaderForTests, type HoldReader } from "@/lib/safety/hold";

const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-._~" + "A1b2C3d4E5f6G7h8I9j0K";
let store = freshStore();
let now = new Date("2026-10-03T00:00:00Z");
let audits: Array<{ action: string; metadata: Record<string, unknown> }>;
let notices: string[];
let rateAllowed = true;
let grantId = "";
let buckets = new Map<string, number>();

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
    rateLimit: async (bucket, limit) => {
      const n = (buckets.get(bucket) ?? 0) + 1;
      buckets.set(bucket, n);
      return { allowed: rateAllowed && n <= limit, count: n, retryAfterSec: 30 };
    },
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
  buckets = new Map();
});

const HID = "00000000-0000-4000-8000-0000000000a1";
const reader = (emp: string | null): HoldReader => ({
  employee: async () => ({ state: "found", orgId: "org_a", holdState: emp, holdId: emp ? HID : null }),
  org: async () => ({ state: "found", orgId: "org_a", holdState: null, holdId: null }),
});
afterEach(() => __setHoldReaderForTests(null));

describe("S2 G2 token endpoint: no new tokens for a held employee; the refresh token is kept", () => {
  test("code exchange while held → 403 access_denied, no tokens; the code is not burnt", async () => {
    const code = await seed();
    __setHoldReaderForTests(reader("stopped"));
    const r = await exchange(code);
    expect(r.status).toBe(403);
    expect((r.body as Record<string, string>).error).toBe("access_denied");
    expect(JSON.stringify(r.body)).not.toContain("sp_at_");
    __setHoldReaderForTests(reader(null));
    expect((await exchange(code)).status).toBe(200);
  });
  test("refresh while held → 403 access_denied; the refresh token still works after release", async () => {
    const code = await seed();
    __setHoldReaderForTests(reader(null));
    const first = await exchange(code);
    expect(first.status).toBe(200);
    const rt = String((first.body as Record<string, string>).refresh_token);
    __setHoldReaderForTests(reader("quarantined"));
    const held = await refresh(rt);
    expect(held.status).toBe(403);
    expect((held.body as Record<string, string>).error).toBe("access_denied");
    __setHoldReaderForTests({ employee: async () => { throw new Error("db"); }, org: async () => { throw new Error("db"); } });
    expect((await refresh(rt)).status).toBe(403);
    __setHoldReaderForTests(reader(null));
    const after = await refresh(rt);
    expect(after.status).toBe(200);
  });
});
