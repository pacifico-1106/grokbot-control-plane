import { NextResponse } from "next/server";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { METADATA_HEADERS, authorizationServerMetadata } from "@/lib/mcp-oauth/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /.well-known/oauth-authorization-server (rewrite). Flag OFF → 404. */
export async function GET() {
  if (!isMcpOAuthEnabled()) return new NextResponse("Not Found", { status: 404 });
  // Kept as is (木村 2026-10-12): METADATA_HEADERS pins application/json for OAuth clients; ASCII-only body.
  // eslint-disable-next-line staffpass/json-utf8
  return NextResponse.json(authorizationServerMetadata(), { headers: METADATA_HEADERS });
}
