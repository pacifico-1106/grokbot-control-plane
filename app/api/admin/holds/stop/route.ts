import { jsonUtf8 } from "@/lib/http/json-utf8";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { startHold } from "@/lib/safety/hold-actions";
import { holdFailureResponse, readJson, refuseAiCredential } from "@/lib/safety/hold-route";

export const dynamic = "force-dynamic";

/**
 * 運営による緊急停止 (/admin, super admin session only). Release of an ops hold is S4
 * (two ops people) and is NOT offered anywhere in S3.
 */
export async function POST(req: Request) {
  const refused = await refuseAiCredential(req, "admin.holds.stop");
  if (refused) return refused;
  const access = await getSuperAdminAccess();
  if (!access.allowed) return jsonUtf8({ ok: false, error: access.reason === "unauthenticated" ? "auth_required" : "forbidden" }, { status: access.reason === "unauthenticated" ? 401 : 403 });
  const body = await readJson(req);
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  if (!orgId) return jsonUtf8({ ok: false, error: "org_required" }, { status: 400 });
  const employeeId = body.scope === "org" ? null : typeof body.employeeId === "string" ? body.employeeId.trim() : "";
  if (employeeId === "") return jsonUtf8({ ok: false, error: "employee_required" }, { status: 400 });
  const result = await startHold({ orgId, employeeId, reason: typeof body.reason === "string" ? body.reason : null,
    actor: { type: "ops", opsId: access.actor.email, surface: "ops_console" } });
  if (!result.ok) return holdFailureResponse(result);
  return jsonUtf8({ ok: true, holdId: result.holdId, created: result.created, upgraded: result.upgraded });
}
