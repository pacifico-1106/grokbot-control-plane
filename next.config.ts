import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // MCP OAuth discovery (handlers 404 while MCP_OAUTH_ENABLED is OFF).
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource/api/mcp",
        destination: "/api/oauth/meta/protected-resource?kind=mcp",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/meta/protected-resource?kind=root",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/meta/authorization-server",
      },
    ];
  },
  // OAuth browser pages: no framing, no caching.
  // Referrer-Policy is `same-origin`, NOT `no-referrer`: with no-referrer the browser
  // sends `Origin: null` on the consent form POST and the same-origin guard returned
  // 403 on every 許可 (same pitfall as AUTH_PAGE_HEADERS in lib/auth/auth-flow.ts).
  // same-origin still sends no Referer to any other origin, so rid never leaks.
  // NOTE: for paths matched here, this value overrides a route handler's own header
  // (Next only appends handler headers the config did not set), and for the same key
  // the LAST matching entry wins.
  async headers() {
    return [
      {
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // /oauth/authorize answers with a 303 that can go to the client's redirect_uri
        // (error responses). Keep it no-referrer, matching OAUTH_PAGE_SECURITY_HEADERS.
        // The code-bearing 303 comes from POST /api/oauth/consent, which this config
        // does not match, so its handler's no-referrer applies.
        source: "/oauth/authorize",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        // LP pattern B is for direct hand-out only: keep it out of search and AI crawlers.
        // Same directives as the page's robots meta. Exact path; A and sub-pages untouched.
        source: "/lp/ai-employee-corp",
        headers: [{ key: "X-Robots-Tag", value: "noindex, follow, noai, noimageai" }],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/docs/guides/instructions-design",
        destination: "/guides/instructions-design",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
