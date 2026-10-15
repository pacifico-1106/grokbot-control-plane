import { jsonUtf8 } from "@/lib/http/json-utf8";
import { readHoldForDisplay } from "@/lib/safety/hold-actions";
import { isEmployeeHoldEnabled, isOrgHoldEnabled } from "@/lib/safety/hold-config";
import { refuseAiCredential, webMemberActor } from "@/lib/safety/hold-route";

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "private, no-store" } };

/** Read-only state for the dashboard (?employeeId= or ?scope=org). IDs / kind only. */
export async function GET(req: Request) {
  const refused = await refuseAiCredential(req, "holds.status");
  if (refused) return refused;
  const who = await webMemberActor(req);
  if (!who.ok) return who.response;
  const url = new URL(req.url);
  const orgScope = url.searchParams.get("scope") === "org";
  const employeeId = orgScope ? null : (url.searchParams.get("employeeId") || "").trim();
  if (!orgScope && employeeId === "") return jsonUtf8({ ok: false, error: "employee_required" }, { status: 400, ...NO_STORE });
  const read = await readHoldForDisplay(who.orgId, employeeId);
  const hold = read.state === "held" ? {
    id: read.hold.id, kind: read.hold.kind, startedVia: read.hold.startedVia, startedAt: read.hold.startedAt,
    opsHold: read.hold.startedVia === "ops_console", releaseRequestedBy: read.hold.releaseRequestedBy,
    releaseRequested: Boolean(read.hold.releaseApprovalId),
  } : null;
  return jsonUtf8({ ok: true, enabled: isEmployeeHoldEnabled(), orgEnabled: isOrgHoldEnabled(), state: read.state, hold,
    me: `member:${who.actor.member.id}` }, NO_STORE);
}
