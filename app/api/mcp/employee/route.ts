/**
 * Badge-only employee MCP. Never advertises OAuth.
 * Flag MCP_EMPLOYEE_BADGE_MCP_ENABLED default OFF → 404 (no new production surface).
 */
import { NextResponse } from "next/server";
import { isEmployeeBadgeMcpEnabled } from "@/lib/feature-flags";
import { employeeMcpGet, employeeMcpOptions, handleBadgeOnlyMcpPost } from "@/lib/mcp/employee-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function off() {
  return new NextResponse("Not Found", { status: 404 });
}

export async function GET() {
  if (!isEmployeeBadgeMcpEnabled()) return off();
  return employeeMcpGet();
}

export async function POST(req: Request) {
  if (!isEmployeeBadgeMcpEnabled()) return off();
  return handleBadgeOnlyMcpPost(req);
}

export async function OPTIONS() {
  if (!isEmployeeBadgeMcpEnabled()) return off();
  return employeeMcpOptions();
}
