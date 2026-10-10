/**
 * Cursor desktop (2026-10-10, production DCR 400): Cursor registers
 * redirect_uris = [cursor://anysphere.cursor-mcp/oauth/callback,
 * https://www.cursor.com/agents/mcp/oauth/callback, http://localhost:8787/callback].
 * The cursor:// URI is allowed as ONE exact string; every other custom scheme
 * and every near-miss stays refused.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_REDIRECT_ALLOWLIST } from "@/lib/mcp-oauth/config";
import { handleAuthorizeRequest } from "@/lib/mcp-oauth/authorize";
import { buildClientRedirect } from "@/lib/mcp-oauth/http";
import { isLoopbackRedirect, isRedirectAllowedForClient, matchesRedirectAllowlist } from "@/lib/mcp-oauth/redirect-policy";
import type { OAuthClientRecord } from "@/lib/data/oauth";
import { ISSUER, RESOURCE, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";
import { CURSOR_DESKTOP_NEAR_MISSES } from "@/lib/mcp-oauth/__tests__/cursor-fixtures";

const CURSOR_DESKTOP = "cursor://anysphere.cursor-mcp/oauth/callback";
const CURSOR_WEB = "https://www.cursor.com/agents/mcp/oauth/callback";
const CURSOR_LOOPBACK = "http://localhost:8787/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";



describe("cursor:// desktop callback — exact match only", () => {
  test("default allowlist has the cursor:// callback as one exact string (no placeholder)", () => {
    expect(DEFAULT_REDIRECT_ALLOWLIST).toContain(CURSOR_DESKTOP);
    const custom = DEFAULT_REDIRECT_ALLOWLIST.filter((p) => !p.startsWith("https://") && !p.startsWith("http://"));
    expect(custom).toEqual([CURSOR_DESKTOP]);
  });

  test("the exact URI is accepted; Cursor's other two callbacks still are", () => {
    expect(matchesRedirectAllowlist(CURSOR_DESKTOP)).toBe(true);
    expect(matchesRedirectAllowlist(CURSOR_WEB)).toBe(true);
    expect(matchesRedirectAllowlist(CURSOR_LOOPBACK)).toBe(true);
    expect(isLoopbackRedirect(CURSOR_DESKTOP)).toBe(false);
  });

  for (const uri of CURSOR_DESKTOP_NEAR_MISSES) {
    test(`near-miss refused: ${JSON.stringify(uri)}`, () => {
      expect(matchesRedirectAllowlist(uri)).toBe(false);
      expect(isRedirectAllowedForClient(uri, [uri, CURSOR_DESKTOP])).toBe(false);
    });
  }

  test("an operator allowlist cannot widen custom schemes: only the built-in cursor:// string is ever eligible", () => {
    expect(matchesRedirectAllowlist("myapp://cb", ["myapp://cb"])).toBe(false);
    expect(matchesRedirectAllowlist("cursor://evil", ["cursor://evil"])).toBe(false);
    expect(matchesRedirectAllowlist("cursor://anysphere.cursor-mcp/oauth/{callback_id}".replace("{callback_id}", "x"), ["cursor://anysphere.cursor-mcp/oauth/{callback_id}"])).toBe(false);
    expect(matchesRedirectAllowlist(CURSOR_DESKTOP, [CURSOR_DESKTOP])).toBe(true);
    // the operator list replaces the default: without the string, refused
    expect(matchesRedirectAllowlist(CURSOR_DESKTOP, [CURSOR_WEB])).toBe(false);
  });

  test("must be registered by the client too (exact)", () => {
    expect(isRedirectAllowedForClient(CURSOR_DESKTOP, [CURSOR_DESKTOP])).toBe(true);
    expect(isRedirectAllowedForClient(CURSOR_DESKTOP, [CURSOR_WEB, CURSOR_LOOPBACK])).toBe(false);
  });

  test("the code redirect keeps the exact base and appends code / state / iss", () => {
    const loc = buildClientRedirect(CURSOR_DESKTOP, { code: "c0de", state: "st" });
    expect(loc.startsWith(`${CURSOR_DESKTOP}?`)).toBe(true);
    const u = new URL(loc);
    expect(u.protocol).toBe("cursor:");
    expect(u.host).toBe("anysphere.cursor-mcp");
    expect(u.pathname).toBe("/oauth/callback");
    expect(u.searchParams.get("code")).toBe("c0de");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("iss")).toBeTruthy();
  });
});

describe("/oauth/authorize with the cursor:// callback", () => {
  const DCR = "dcr_cursorDesktopTest";
  let store = freshStore();
  const client = (): OAuthClientRecord => ({
    clientId: DCR, registrationType: "dcr", clientName: "Cursor", clientUri: null, logoUri: null,
    redirectUris: [CURSOR_DESKTOP, CURSOR_WEB, CURSOR_LOOPBACK], tokenEndpointAuthMethod: "none", metadata: {},
    metadataFetchedAt: null, metadataExpiresAt: null, status: "active", createdIpHash: null, lastUsedAt: null, createdAt: new Date().toISOString(),
  });
  const deps = () => ({ store, lookupClient: async () => ({ ok: true as const, client: client() }) });
  const url = (redirectUri: string, extra: Record<string, string> = {}) => {
    const u = new URL(`${ISSUER}/oauth/authorize`);
    const p: Record<string, string> = { client_id: DCR, redirect_uri: redirectUri, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", resource: RESOURCE, scope: "staffpass.employee", state: "st_c", ...extra };
    for (const [k, v] of Object.entries(p)) if (v !== "__omit__") u.searchParams.set(k, v);
    return u;
  };
  beforeEach(() => {
    store = freshStore();
    delete process.env.MCP_OAUTH_ISSUER;
    delete process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
  });

  test("accepted → consent; the stored redirect_uri is the exact cursor:// string", async () => {
    const out = await handleAuthorizeRequest(url(CURSOR_DESKTOP), deps());
    if (out.type !== "redirect") throw new Error(JSON.stringify(out));
    expect(new URL(out.location).pathname).toBe("/oauth/consent");
    const rid = new URL(out.location).searchParams.get("rid")!;
    expect((await store.getAuthRequest(rid))?.redirectUri).toBe(CURSOR_DESKTOP);
  });

  test("PKCE S256 is still required for the custom scheme (missing / plain → error back to the verified URI)", async () => {
    const variants: Record<string, string>[] = [{ code_challenge_method: "plain" }, { code_challenge: "__omit__", code_challenge_method: "__omit__" }];
    for (const extra of variants) {
      const out = await handleAuthorizeRequest(url(CURSOR_DESKTOP, extra), deps());
      if (out.type !== "redirect") throw new Error(JSON.stringify(out));
      const u = new URL(out.location);
      expect(u.protocol).toBe("cursor:");
      expect(u.searchParams.get("error")).toBe("invalid_request");
      expect(u.searchParams.get("code")).toBeNull();
    }
  });

  for (const uri of CURSOR_DESKTOP_NEAR_MISSES) {
    test(`near-miss → 400 page, no redirect: ${JSON.stringify(uri)}`, async () => {
      const out = await handleAuthorizeRequest(url(uri), deps());
      expect(out).toMatchObject({ type: "page", status: 400, error: "invalid_redirect_uri" });
    });
  }
});
