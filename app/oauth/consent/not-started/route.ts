import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { NOT_STARTED_HERE_MESSAGE_JA } from "@/lib/mcp-oauth/consent";
import { oauthErrorPage } from "@/lib/mcp-oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Not started in this browser" page as a real HTTP 403 (hardening 2b).
 * The consent page redirects here when the rid-binding cookie is missing/invalid.
 * Flag OFF → 404.
 */
export async function GET() {
  if (!isMcpOAuthEnabled()) return new Response("Not Found", { status: 404 });
  return oauthErrorPage(403, "access_denied", NOT_STARTED_HERE_MESSAGE_JA);
}
