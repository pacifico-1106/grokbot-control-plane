import { jsonUtf8 } from "@/lib/http/json-utf8";
import { approveHoldRelease } from "@/lib/safety/hold-actions";
import { holdFailureResponse, readJson, refuseAiCredential, webMemberActor } from "@/lib/safety/hold-route";

export const dynamic = "force-dynamic";

/** 解除の承認 (web only, fresh login, a different owner / designated admin). Body: { holdId }. */
export async function POST(req: Request) {
  const refused = await refuseAiCredential(req, "holds.release.approve");
  if (refused) return refused;
  const body = await readJson(req);
  const who = await webMemberActor(req, typeof body.actorMemberId === "string" ? body.actorMemberId : null);
  if (!who.ok) return who.response;
  const holdId = typeof body.holdId === "string" ? body.holdId.trim() : "";
  if (!holdId) return jsonUtf8({ ok: false, error: "hold_required" }, { status: 400 });
  const result = await approveHoldRelease({ orgId: who.orgId, holdId, actor: who.actor });
  if (!result.ok) return holdFailureResponse(result);
  return jsonUtf8({ ok: true, holdId: result.holdId, closedTickets: result.closedTickets });
}
