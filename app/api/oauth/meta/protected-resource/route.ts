import { NextResponse } from "next/server";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { METADATA_HEADERS, protectedResourceMetadata } from "@/lib/mcp-oauth/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Served via next.config rewrites:
 *   /.well-known/oauth-protected-resource          → ?kind=root
 *   /.well-known/oauth-protected-resource/api/mcp  → ?kind=mcp
 * Flag OFF → 404 (same as today).
 */
export async function GET(req: Request) {
  if (!isMcpOAuthEnabled()) return new NextResponse("Not Found", { status: 404 });
  const kind = new URL(req.url).searchParams.get("kind") === "mcp" ? "mcp" : "root";
  return NextResponse.json(protectedResourceMetadata(kind), { headers: METADATA_HEADERS });
}
