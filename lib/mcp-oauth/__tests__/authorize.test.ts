import { beforeEach, describe, expect, test } from "bun:test";
import { handleAuthorizeRequest } from "@/lib/mcp-oauth/authorize";
import type { OAuthClientRecord } from "@/lib/data/oauth";
import { CLAUDE_CLIENT, ISSUER, RESOURCE, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";

const CB = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function client(over: Partial<OAuthClientRecord> = {}): OAuthClientRecord {
  return {
    clientId: CLAUDE_CLIENT,
    registrationType: "cimd",
    clientName: "Claude",
    clientUri: null,
    logoUri: null,
    redirectUris: [CB, "http://localhost:3334/callback"],
    tokenEndpointAuthMethod: "none",
    metadata: {},
    metadataFetchedAt: null,
    metadataExpiresAt: null,
    status: "active",
    createdIpHash: null,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

let store = freshStore();
beforeEach(async () => {
  store = freshStore();
  delete process.env.MCP_OAUTH_ISSUER;
  const c = client();
  await store.upsertClient({ ...c });
});

function url(params: Record<string, string | string[]>) {
  const u = new URL(`${ISSUER}/oauth/authorize`);
  const base: Record<string, string | string[]> = {
    client_id: CLAUDE_CLIENT,
    redirect_uri: CB,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "staffpass.employee",
    state: "st_123",
    ...params,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === "__omit__") continue;
    for (const one of Array.isArray(v) ? v : [v]) u.searchParams.append(k, one);
  }
  return u;
}

const deps = (over: Partial<OAuthClientRecord> | null = {}) => ({
  store,
  lookupClient: async () => (over === null ? { ok: false as const, error: "cimd_fetch_failed" } : { ok: true as const, client: client(over) }),
});

describe("/oauth/authorize", () => {
  test("happy path: stores request and 303s to consent with opaque rid (no secrets in URL)", async () => {
    const out = await handleAuthorizeRequest(url({}), deps());
    expect(out.type).toBe("redirect");
    if (out.type !== "redirect") return;
    const loc = new URL(out.location);
    expect(loc.origin + loc.pathname).toBe(`${ISSUER}/oauth/consent`);
    const rid = loc.searchParams.get("rid")!;
    expect(rid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...loc.searchParams.keys()]).toEqual(["rid"]);
    const rec = await store.getAuthRequest(rid);
    expect(rec?.redirectUri).toBe(CB);
    expect(rec?.state).toBe("st_123");
    expect(rec?.codeChallenge).toBe(CHALLENGE);
    expect(rec?.resource).toBe(RESOURCE);
    expect(rec?.scope).toEqual(["staffpass.employee", "offline_access"]);
    expect(Date.parse(rec!.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
  });

  test("unknown client → error page, never a redirect", async () => {
    const out = await handleAuthorizeRequest(url({}), deps(null));
    expect(out).toMatchObject({ type: "page", status: 400, error: "invalid_client" });
  });

  test("blocked client → error page", async () => {
    const out = await handleAuthorizeRequest(url({}), deps({ status: "blocked" }));
    expect(out).toMatchObject({ type: "page", error: "invalid_client" });
  });

  test("redirect_uri not registered / not allowlisted / missing → error page, never a redirect", async () => {
    for (const bad of ["https://evil.example/cb", "https://claude.ai/api/mcp/auth_callback/x", "https://claude.ai.evil.com/api/mcp/auth_callback", "__omit__"]) {
      const out = await handleAuthorizeRequest(url({ redirect_uri: bad }), deps());
      expect(out).toMatchObject({ type: "page", error: "invalid_redirect_uri" });
    }
    // registered by client but not on server allowlist
    const out = await handleAuthorizeRequest(url({ redirect_uri: "https://evil.example/cb" }), deps({ redirectUris: ["https://evil.example/cb"] }));
    expect(out).toMatchObject({ type: "page", error: "invalid_redirect_uri" });
  });

  test("duplicate client_id / redirect_uri → error page", async () => {
    const out = await handleAuthorizeRequest(url({ redirect_uri: [CB, CB] }), deps());
    expect(out).toMatchObject({ type: "page", error: "invalid_request" });
  });

  test("loopback redirect with a different runtime port is accepted (RFC 8252)", async () => {
    const out = await handleAuthorizeRequest(url({ redirect_uri: "http://localhost:51234/callback" }), deps());
    expect(out.type).toBe("redirect");
    if (out.type === "redirect") expect(out.location).toContain("/oauth/consent?rid=");
  });

  const redirectErr = async (params: Record<string, string | string[]>, error: string) => {
    const out = await handleAuthorizeRequest(url(params), deps());
    expect(out.type).toBe("redirect");
    if (out.type !== "redirect") return;
    const loc = new URL(out.location);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get("error")).toBe(error);
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    return loc;
  };

  test("response_type != code → unsupported_response_type with state + iss", async () => {
    const loc = await redirectErr({ response_type: "token" }, "unsupported_response_type");
    expect(loc?.searchParams.get("state")).toBe("st_123");
  });

  test("PKCE: missing, plain, or malformed challenge → invalid_request", async () => {
    await redirectErr({ code_challenge_method: "plain" }, "invalid_request");
    await redirectErr({ code_challenge_method: "__omit__" }, "invalid_request");
    await redirectErr({ code_challenge: "__omit__" }, "invalid_request");
    await redirectErr({ code_challenge: "short" }, "invalid_request");
  });

  test("resource must be one of the allowed two; missing defaults to /api/mcp", async () => {
    await redirectErr({ resource: "https://evil.example/api/mcp" }, "invalid_target");
    await redirectErr({ resource: `${ISSUER}/api/mcp/admin` }, "invalid_target");
    const ok1 = await handleAuthorizeRequest(url({ resource: ISSUER }), deps());
    expect(ok1.type === "redirect" && ok1.location.includes("/oauth/consent")).toBe(true);
    const ok2 = await handleAuthorizeRequest(url({ resource: "__omit__" }), deps());
    if (ok2.type === "redirect" && ok2.rid) expect((await store.getAuthRequest(ok2.rid))?.resource).toBe(RESOURCE);
    else throw new Error("expected redirect");
  });

  test("unknown scopes are ignored and normalized", async () => {
    const out = await handleAuthorizeRequest(url({ scope: "admin openid staffpass.employee" }), deps());
    if (out.type !== "redirect" || !out.rid) throw new Error("expected redirect");
    expect((await store.getAuthRequest(out.rid))?.scope).toEqual(["staffpass.employee", "offline_access"]);
  });

  test("duplicate non-identity params / oversized state → invalid_request on the redirect", async () => {
    await redirectErr({ scope: ["a", "b"] }, "invalid_request");
    const loc = await redirectErr({ state: "x".repeat(2000) }, "invalid_request");
    expect(loc?.searchParams.get("state")).toBeNull();
  });
});
