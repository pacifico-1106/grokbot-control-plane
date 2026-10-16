import { jsonUtf8 } from "@/lib/http/json-utf8";
import { readHoldForDisplay } from "@/lib/safety/hold-actions";
import { isEmployeeHoldEnabled, isOrgHoldEnabled } from "@/lib/safety/hold-config";
import { buildHoldPanelStatus } from "@/lib/safety/hold-display";
import { readJson, refuseAiCredential, refuseUnsafeBrowserPost, webMemberActor } from "@/lib/safety/hold-route";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const NO_STORE = {
  headers: {
    "cache-control": "private, no-store, no-cache, max-age=0, must-revalidate",
    "cdn-cache-control": "no-store",
    "vercel-cdn-cache-control": "no-store",
  },
};

async function statusResponse(req: Request, orgScope: boolean, employeeId: string | null) {
  const refused = await refuseAiCredential(req, "holds.status");
  if (refused) return refused;
  const who = await webMemberActor(req);
  if (!who.ok) return who.response;
  if (!orgScope && !employeeId) return jsonUtf8({ ok: false, error: "employee_required" }, { status: 400, ...NO_STORE });
  const read = await readHoldForDisplay(who.orgId, orgScope ? null : employeeId);
  return jsonUtf8(buildHoldPanelStatus({
    enabled: isEmployeeHoldEnabled(),
    orgEnabled: isOrgHoldEnabled(),
    memberId: who.actor.member.id,
    read,
  }), NO_STORE);
}

/** Read-only state for the dashboard (?employeeId= or ?scope=org). IDs / kind only. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgScope = url.searchParams.get("scope") === "org";
  const employeeId = orgScope ? null : (url.searchParams.get("employeeId") || "").trim();
  return statusResponse(req, orgScope, employeeId);
}

/** Same as GET. POST so a CDN cannot keep serving a cached `{state:none}`. */
export async function POST(req: Request) {
  const unsafe = refuseUnsafeBrowserPost(req);
  if (unsafe) return unsafe;
  const body = await readJson(req);
  const orgScope = body.scope === "org";
  const employeeId = orgScope ? null : typeof body.employeeId === "string" ? body.employeeId.trim() : "";
  return statusResponse(req, orgScope, employeeId);
}
