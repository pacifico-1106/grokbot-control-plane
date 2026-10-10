import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { TOKEN_RESPONSE_HEADERS, defaultTokenDeps, handleTokenRequest, toResponse } from "@/lib/mcp-oauth/token-endpoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  if (!isMcpOAuthEnabled()) return new Response("Not Found", { status: 404 });
  return new Response(null, { status: 204, headers: TOKEN_RESPONSE_HEADERS });
}

/** OAuth token endpoint (PR-6). Flag OFF → 404. */
export async function POST(req: Request) {
  if (!isMcpOAuthEnabled()) return new Response("Not Found", { status: 404 });
  return toResponse(await handleTokenRequest(req, await defaultTokenDeps()));
}
