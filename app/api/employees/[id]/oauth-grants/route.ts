import { getCurrentOrgId } from "@/lib/auth/session";
import { getEmployee } from "@/lib/data";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { listEmployeeGrants } from "@/lib/mcp-oauth/grant-admin";
import { requireCapability } from "@/lib/team/demo-actor";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List AI-client (OAuth) connections of an employee. Flag OFF → 404. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isMcpOAuthEnabled()) return jsonUtf8({ error: "not_found" }, { status: 404 });
  const gate = await requireCapability(req, "hire_issue_credentials");
  if (!gate.ok) return gate.response;
  const orgId = await getCurrentOrgId();
  if (!orgId) return jsonUtf8({ error: "auth_required" }, { status: 401 });
  const { id } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) return jsonUtf8({ error: "employee_not_found" }, { status: 404 });
  const grants = await listEmployeeGrants(orgId, id);
  return jsonUtf8({ ok: true, grants }, { headers: { "Cache-Control": "no-store" } });
}
