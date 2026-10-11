import { describe, expect, test } from "bun:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "@/next.config";
import { OAUTH_PAGE_SECURITY_HEADERS, buildClientRedirect, redirect303 } from "@/lib/mcp-oauth/http";

/**
 * Which Referrer-Policy each OAuth response actually carries.
 *
 * Next.js semantics (15.5, server/lib/router-utils/resolve-routes.js + server/send-response.js):
 *  - every matching `headers()` entry is applied in order, so for the same key the LAST match wins;
 *  - a route handler's own header is only appended when the config did NOT already set that key,
 *    i.e. next.config wins over the handler for any path it matches.
 * `effective()` reproduces that so the test checks what the browser receives.
 */
async function configHeaders(pathname: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const rules = (await nextConfig.headers?.()) ?? [];
  for (const rule of rules) {
    if (getPathMatch(rule.source)(pathname) === false) continue;
    for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}
async function effective(pathname: string, handler: Response | null, key: string): Promise<string | null> {
  const cfg = await configHeaders(pathname);
  if (key.toLowerCase() in cfg) return cfg[key.toLowerCase()];
  return handler?.headers.get(key) ?? null;
}

describe("/oauth/consent page (form lives here)", () => {
  test("Referrer-Policy is same-origin, so the 許可 form POST carries a real Origin (not `null`)", async () => {
    expect(await effective("/oauth/consent", null, "referrer-policy")).toBe("same-origin");
  });
  test("framing / caching / sniffing protections are still set", async () => {
    const h = await configHeaders("/oauth/consent");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["cache-control"]).toBe("no-store");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });
});

describe("responses that may redirect to the client stay no-referrer", () => {
  test("OAUTH_PAGE_SECURITY_HEADERS keeps no-referrer", () => {
    expect(OAUTH_PAGE_SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });

  test("POST /api/oauth/consent 303 to the client (code + state): no config override, handler no-referrer wins", async () => {
    const loc = buildClientRedirect("https://claude.ai/api/mcp/auth_callback", { code: "c", state: "s" });
    const res = redirect303(loc);
    expect(await configHeaders("/api/oauth/consent")).not.toHaveProperty("referrer-policy");
    expect(await effective("/api/oauth/consent", res, "referrer-policy")).toBe("no-referrer");
  });

  test("GET /oauth/authorize 303 (to consent, or error redirect to the client) is no-referrer even though /oauth/:path* is same-origin", async () => {
    const res = redirect303(buildClientRedirect("https://claude.ai/api/mcp/auth_callback", { error: "access_denied", state: "s" }));
    expect(await effective("/oauth/authorize", res, "referrer-policy")).toBe("no-referrer");
    const h = await configHeaders("/oauth/authorize");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["cache-control"]).toBe("no-store");
  });
});
