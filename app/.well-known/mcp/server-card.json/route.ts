import { NextResponse } from "next/server";
import { SERVER_CARD_CACHE_CONTROL, buildServerCard } from "@/lib/mcp/server-card";

export const runtime = "nodejs";
/**
 * Revalidated about once an hour (ISR, 木村 decision 2). Literal on purpose: Next.js segment
 * config must be statically analyzable; the route test pins it to SERVER_CARD_REVALIDATE_SECONDS.
 * The card depends only on config (resolveAppOrigin), never on the request, so caching is safe.
 */
export const revalidate = 3600;

/** Employee badge MCP server card — URLs from resolveAppOrigin() (no hardcode, no Host header). */
export async function GET() {
  return NextResponse.json(buildServerCard(), { headers: { "Cache-Control": SERVER_CARD_CACHE_CONTROL } });
}
