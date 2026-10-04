import { NextResponse } from "next/server";
import { buildServerCard } from "@/lib/mcp/server-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Employee badge MCP server card — URLs from resolveAppOrigin() (no hardcode, no Host header). */
export async function GET() {
  return NextResponse.json(buildServerCard());
}
