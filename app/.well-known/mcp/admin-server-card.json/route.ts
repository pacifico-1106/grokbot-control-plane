import { NextResponse } from "next/server";
import { buildAdminServerCard } from "@/lib/mcp/server-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin MCP server card — URLs from resolveAppOrigin() (no hardcode, no Host header). */
export async function GET() {
  return NextResponse.json(buildAdminServerCard());
}
