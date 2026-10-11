import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isSameOriginBrowserPost } from "@/lib/mcp-oauth/http";

/**
 * isSameOriginBrowserPost — `Origin: null` handling.
 * The consent page used to be served with Referrer-Policy: no-referrer, so the browser
 * sent `Origin: null` on the form POST and every 許可 click got 403. `null` is now
 * accepted ONLY together with the browser-set `Sec-Fetch-Site: same-origin`.
 */
const ISSUER = "https://staffpass.example";
const saved = process.env.MCP_OAUTH_ISSUER;
beforeEach(() => {
  process.env.MCP_OAUTH_ISSUER = ISSUER;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_OAUTH_ISSUER;
  else process.env.MCP_OAUTH_ISSUER = saved;
});

function req(headers: Record<string, string>, url = `${ISSUER}/api/oauth/consent`) {
  return new Request(url, { method: "POST", headers });
}
const both = [{ requireOrigin: true }, { requireOrigin: false }] as const;

describe("Origin: null", () => {
  for (const opts of both) {
    test(`null + Sec-Fetch-Site same-origin → accepted (requireOrigin=${opts.requireOrigin})`, () => {
      expect(isSameOriginBrowserPost(req({ origin: "null", "sec-fetch-site": "same-origin" }), opts)).toBe(true);
    });

    test(`null without Sec-Fetch-Site → rejected (fail closed for old browsers) (requireOrigin=${opts.requireOrigin})`, () => {
      expect(isSameOriginBrowserPost(req({ origin: "null" }), opts)).toBe(false);
    });

    for (const site of ["cross-site", "same-site", "none", "", "Same-Origin", "same-origin, cross-site"]) {
      test(`null + Sec-Fetch-Site ${JSON.stringify(site)} → rejected (requireOrigin=${opts.requireOrigin})`, () => {
        expect(isSameOriginBrowserPost(req({ origin: "null", "sec-fetch-site": site }), opts)).toBe(false);
      });
    }
  }

  test("only the exact string `null` gets the fallback (`Null`, ` null`, `null, null` stay rejected)", () => {
    for (const o of ["Null", "NULL", "null, null", "nul"]) {
      expect(isSameOriginBrowserPost(req({ origin: o, "sec-fetch-site": "same-origin" }), { requireOrigin: true })).toBe(false);
    }
  });
});

describe("real Origin values (unchanged behaviour)", () => {
  test("external Origin → rejected, even with Sec-Fetch-Site same-origin (not browser-reachable, still refused)", () => {
    for (const site of [undefined, "same-origin", "cross-site", "same-site", "none"]) {
      const h: Record<string, string> = { origin: "https://evil.example" };
      if (site) h["sec-fetch-site"] = site;
      expect(isSameOriginBrowserPost(req(h), { requireOrigin: true })).toBe(false);
      expect(isSameOriginBrowserPost(req(h), { requireOrigin: false })).toBe(false);
    }
  });

  test("sibling subdomain / scheme / port variants of the issuer → rejected", () => {
    for (const o of ["https://evil.staffpass.example", "http://staffpass.example", "https://staffpass.example:8443", "https://staffpass.example.evil.example"]) {
      expect(isSameOriginBrowserPost(req({ origin: o, "sec-fetch-site": "same-origin" }), { requireOrigin: true })).toBe(false);
    }
  });

  test("correct Origin → accepted (with Sec-Fetch-Site same-origin, and without it)", () => {
    expect(isSameOriginBrowserPost(req({ origin: ISSUER, "sec-fetch-site": "same-origin" }), { requireOrigin: true })).toBe(true);
    expect(isSameOriginBrowserPost(req({ origin: ISSUER }), { requireOrigin: true })).toBe(true);
  });

  test("correct Origin but Sec-Fetch-Site cross-site → rejected", () => {
    expect(isSameOriginBrowserPost(req({ origin: ISSUER, "sec-fetch-site": "cross-site" }), { requireOrigin: true })).toBe(false);
  });

  test("request origin (preview host) is accepted alongside the issuer", () => {
    const preview = "https://preview-123.vercel.app";
    expect(isSameOriginBrowserPost(req({ origin: preview, "sec-fetch-site": "same-origin" }, `${preview}/api/oauth/consent`), { requireOrigin: true })).toBe(true);
  });

  test("missing Origin: rejected when required, allowed only when not required (unchanged)", () => {
    expect(isSameOriginBrowserPost(req({ "sec-fetch-site": "same-origin" }), { requireOrigin: true })).toBe(false);
    expect(isSameOriginBrowserPost(req({}), { requireOrigin: true })).toBe(false);
    expect(isSameOriginBrowserPost(req({}), { requireOrigin: false })).toBe(true);
    expect(isSameOriginBrowserPost(req({ "sec-fetch-site": "cross-site" }), { requireOrigin: false })).toBe(false);
  });
});
