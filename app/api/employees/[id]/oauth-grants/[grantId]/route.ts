import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getEmployee } from "@/lib/data";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { revokeEmployeeGrant } from "@/lib/mcp-oauth/grant-admin";
import { isSameOriginBrowserPost } from "@/lib/mcp-oauth/http";
import { requireCapability } from "@/lib/team/demo-actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoke one AI-client (OAuth) connection. hire_issue_credentials; same org only. Flag OFF → 404. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; grantId: string }> }) {
  if (!isMcpOAuthEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isSameOriginBrowserPost(req, { requireOrigin: false })) {
    return NextResponse.json({ error: "origin_mismatch" }, { status: 403 });
  }
  const gate = await requireCapability(req, "hire_issue_credentials");
  if (!gate.ok) return gate.response;
  const orgId = await getCurrentOrgId();
  if (!orgId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  const { id, grantId } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  const grant = await revokeEmployeeGrant({ orgId, employeeId: id, grantId, byEmail: gate.actor.email });
  if (!grant) return NextResponse.json({ error: "grant_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, grant });
}
