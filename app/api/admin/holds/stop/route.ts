import { jsonUtf8 } from "@/lib/http/json-utf8";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { actorForAdminStop, startHold } from "@/lib/safety/hold-actions";
import { holdFailureResponse, readJson, refuseAiCredential, refuseUnsafeBrowserPost } from "@/lib/safety/hold-route";

export const dynamic = "force-dynamic";

/**
 * /admin 緊急停止 (super admin session only). A super-admin who is an active
 * owner of the target org is stamped as a tenant web hold (they can release on
 * /app with the 2-person rule). Anyone else is ops_console; those holds are S4
 * (two ops people) and are NOT offered anywhere in S3.
 */
export async function POST(req: Request) {
  const refused = await refuseAiCredential(req, "admin.holds.stop");
  if (refused) return refused;
  const unsafe = refuseUnsafeBrowserPost(req);
  if (unsafe) return unsafe;
  const access = await getSuperAdminAccess();
  if (!access.allowed) return jsonUtf8({ ok: false, error: access.reason === "unauthenticated" ? "auth_required" : "forbidden" }, { status: access.reason === "unauthenticated" ? 401 : 403 });
  const body = await readJson(req);
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  if (!orgId) return jsonUtf8({ ok: false, error: "org_required" }, { status: 400 });
  const employeeId = body.scope === "org" ? null : typeof body.employeeId === "string" ? body.employeeId.trim() : "";
  if (employeeId === "") return jsonUtf8({ ok: false, error: "employee_required" }, { status: 400 });
  const actor = await actorForAdminStop({ orgId, opsEmail: access.actor.email, opsUserId: access.actor.userId });
  const result = await startHold({ orgId, employeeId, reason: typeof body.reason === "string" ? body.reason : null, actor });
  if (!result.ok) return holdFailureResponse(result);
  return jsonUtf8({ ok: true, holdId: result.holdId, created: result.created, upgraded: result.upgraded, via: actor.surface });
}
