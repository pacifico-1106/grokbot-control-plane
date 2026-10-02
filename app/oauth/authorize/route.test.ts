import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CLAUDE_CLIENT, ISSUER, RESOURCE, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";

/** Route-level tests for /oauth/authorize, POST /api/oauth/consent, login Origin guard, logout next. */
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
mock.module("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}));

const { __setOAuthStoreForTests } = await import("@/lib/data/oauth");
const { __setConsentDepsForTests } = await import("@/lib/mcp-oauth/consent");
const { mintConsentCsrf } = await import("@/lib/mcp-oauth/csrf");
const authorize = await import("./route");
const consent = await import("@/app/api/oauth/consent/route");
const login = await import("@/app/api/auth/login/route");
const logout = await import("@/app/api/auth/logout/route");

const CB = "https://claude.ai/api/mcp/auth_callback";
const SECRET = "k".repeat(40);
const ENV = ["MCP_OAUTH_ENABLED", "IP_HASH_KEY", "MCP_OAUTH_ORG_ALLOWLIST", "MCP_OAUTH_ISSUER"];
const saved: Record<string, string | undefined> = {};
let store = freshStore();

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.IP_HASH_KEY = "i".repeat(40);
  delete process.env.MCP_OAUTH_ORG_ALLOWLIST;
  delete process.env.MCP_OAUTH_ISSUER;
  store = freshStore();
  __setOAuthStoreForTests(store);
  await store.upsertClient({
    clientId: CLAUDE_CLIENT,
    registrationType: "cimd",
    clientName: "Claude",
    clientUri: null,
    logoUri: null,
    redirectUris: [CB],
    tokenEndpointAuthMethod: "none",
    metadata: {},
    metadataFetchedAt: new Date().toISOString(),
    metadataExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: "active",
    createdIpHash: null,
  });
});
afterEach(() => {
  __setOAuthStoreForTests(null);
  __setConsentDepsForTests(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const authorizeUrl = `${ISSUER}/oauth/authorize?client_id=${encodeURIComponent(CLAUDE_CLIENT)}&redirect_uri=${encodeURIComponent(CB)}&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}&state=s1`;

describe("GET /oauth/authorize", () => {
  test("flag OFF → 404", async () => {
    delete process.env.MCP_OAUTH_ENABLED;
    expect((await authorize.GET(new Request(authorizeUrl))).status).toBe(404);
  });

  test("IP_HASH_KEY missing → 503 (fail closed)", async () => {
    delete process.env.IP_HASH_KEY;
    expect((await authorize.GET(new Request(authorizeUrl))).status).toBe(503);
  });

  test("ON → 303 to consent with security headers", async () => {
    const res = await authorize.GET(new Request(authorizeUrl, { headers: { "x-forwarded-for": "203.0.113.5" } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")!.startsWith(`${ISSUER}/oauth/consent?rid=`)).toBe(true);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("bad redirect_uri → HTML error page (no Location), framing denied", async () => {
    const res = await authorize.GET(new Request(authorizeUrl.replace(encodeURIComponent(CB), encodeURIComponent("https://evil.example/cb"))));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).not.toContain("evil.example");
  });

  test("rate limit 30/min per IP", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await authorize.GET(new Request(authorizeUrl, { headers: { "x-forwarded-for": "198.51.100.7" } }))).status;
    expect(last).toBe(429);
  });
});

function consentReq(body: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${ISSUER}/api/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, "sec-fetch-site": "same-origin", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

describe("POST /api/oauth/consent", () => {
  async function wire() {
    const authRes = await authorize.GET(new Request(authorizeUrl, { headers: { "x-forwarded-for": "192.0.2.1" } }));
    const rid = new URL(authRes.headers.get("location")!).searchParams.get("rid")!;
    const now = new Date();
    __setConsentDepsForTests({
      store,
      getSession: async () => ({
        userId: "u1",
        email: "owner@example.jp",
        orgId: "org_a",
        member: { id: "m1", orgId: "org_a", email: "owner@example.jp", displayName: "o", role: "owner", status: "active", capabilities: ["hire_issue_credentials"] } as never,
        lastSignInAt: new Date(now.getTime() - 60_000).toISOString(),
      }),
      getEmployeeById: async (id) => (id === "emp_1" ? ({ id, orgId: "org_a", displayName: "営業AI", roleLabel: "", status: "active", scopes: [], allowedPurposes: [] } as never) : null),
      listEmployees: async () => [],
      getBinding: async () => ({ status: "linked" }),
      getCurrentCredential: async () => ({ credentialId: "c1", expiresAt: null }),
      getOrgName: async () => "Org",
      getAal: async () => "aal1",
      audit: async () => undefined,
      notify: async () => undefined,
      rateLimit: async () => ({ allowed: true, count: 1, retryAfterSec: 60 }),
      stateSecret: () => SECRET,
      now: () => now,
    });
    return { rid, csrf: mintConsentCsrf(SECRET, rid, "u1", now) };
  }

  test("flag OFF → 404", async () => {
    delete process.env.MCP_OAUTH_ENABLED;
    expect((await consent.POST(consentReq({}))).status).toBe(404);
  });

  test("cross-site Origin, missing Origin, Sec-Fetch-Site cross-site, Origin null → 403", async () => {
    const { rid, csrf } = await wire();
    const body = { rid, csrf, decision: "allow", employee_id: "emp_1", confirm: "yes" };
    expect((await consent.POST(consentReq(body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await consent.POST(consentReq(body, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await consent.POST(consentReq(body, { origin: "null" }))).status).toBe(403);
    const noOrigin = new Request(`${ISSUER}/api/oauth/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
    expect((await consent.POST(noOrigin)).status).toBe(403);
    expect((await store.getAuthRequest(rid))?.consumedAt).toBeNull();
  });

  test("JSON body → 415", async () => {
    const res = await consent.POST(new Request(`${ISSUER}/api/oauth/consent`, { method: "POST", headers: { "content-type": "application/json", origin: ISSUER }, body: "{}" }));
    expect(res.status).toBe(415);
  });

  test("same-origin form allow → 303 to client with code + state + iss", async () => {
    const { rid, csrf } = await wire();
    const res = await consent.POST(consentReq({ rid, csrf, decision: "allow", employee_id: "emp_1", confirm: "yes" }));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("login Origin guard (only while OAuth is ON)", () => {
  test("cross-origin login POST → 403", async () => {
    const res = await login.POST(
      new Request(`${ISSUER}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
        body: "email=a%40b.c&password=x",
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("logout next (consent org switch / re-login)", () => {
  const post = (next: string) =>
    logout.POST(
      new Request(`${ISSUER}/api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ next }).toString(),
      })
    );
  test("only /oauth/consent?rid=<token> is carried to /login?next=", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-test";
    const ok = await post("/oauth/consent?rid=abc_DEF-123");
    expect(new URL(ok.headers.get("location")!).searchParams.get("next")).toBe("/oauth/consent?rid=abc_DEF-123");
    for (const bad of ["https://evil.example/", "//evil.example", "/oauth/consent?rid=a&x=https://evil", "/app"]) {
      const res = await post(bad);
      expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBeNull();
    }
  });
});
