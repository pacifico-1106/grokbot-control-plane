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
  // OAuth browser pages: no framing, no caching, no referrer (rid / code never leak).
  async headers() {
    return [
      {
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
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
