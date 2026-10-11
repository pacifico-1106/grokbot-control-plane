import { jsonUtf8 } from "@/lib/http/json-utf8";
import { requestHoldRelease } from "@/lib/safety/hold-actions";
import { holdFailureResponse, readJson, refuseAiCredential, webMemberActor } from "@/lib/safety/hold-route";

export const dynamic = "force-dynamic";

/** 解除申請 (web only, fresh login). Body: { holdId, reason }. */
export async function POST(req: Request) {
  const refused = await refuseAiCredential(req, "holds.release.request");
  if (refused) return refused;
  const body = await readJson(req);
  const who = await webMemberActor(req, typeof body.actorMemberId === "string" ? body.actorMemberId : null);
  if (!who.ok) return who.response;
  const holdId = typeof body.holdId === "string" ? body.holdId.trim() : "";
  if (!holdId) return jsonUtf8({ ok: false, error: "hold_required" }, { status: 400 });
  const result = await requestHoldRelease({ orgId: who.orgId, holdId, reason: typeof body.reason === "string" ? body.reason : "", actor: who.actor });
  if (!result.ok) return holdFailureResponse(result);
  return jsonUtf8({ ok: true, approvalId: result.approvalId, singleOwnerSelfRelease: result.singleOwnerSelfRelease });
}
