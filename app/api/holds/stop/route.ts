import { jsonUtf8 } from "@/lib/http/json-utf8";
import { startHold } from "@/lib/safety/hold-actions";
import { holdFailureResponse, readJson, refuseAiCredential, refuseUnsafeBrowserPost, webMemberActor } from "@/lib/safety/hold-route";

export const dynamic = "force-dynamic";

/** 緊急停止 (web). Body: { employeeId } or { scope: "org" }, optional { reason }. Human session only. */
export async function POST(req: Request) {
  const refused = await refuseAiCredential(req, "holds.stop");
  if (refused) return refused;
  const unsafe = refuseUnsafeBrowserPost(req);
  if (unsafe) return unsafe;
  const body = await readJson(req);
  const who = await webMemberActor(req, typeof body.actorMemberId === "string" ? body.actorMemberId : null);
  if (!who.ok) return who.response;
  const employeeId = body.scope === "org" ? null : typeof body.employeeId === "string" ? body.employeeId.trim() : "";
  if (employeeId === "") return jsonUtf8({ ok: false, error: "employee_required" }, { status: 400 });
  const result = await startHold({ orgId: who.orgId, employeeId, reason: typeof body.reason === "string" ? body.reason : null, actor: who.actor });
  if (!result.ok) return holdFailureResponse(result);
  return jsonUtf8({ ok: true, holdId: result.holdId, created: result.created, upgraded: result.upgraded });
}
