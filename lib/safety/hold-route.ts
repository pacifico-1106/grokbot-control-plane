/**
 * S3 route helpers. Hold routes are browser-session only: ANY bearer / credential header
 * (社員証 gb_emp_, tenant gb_adm_, OAuth sp_at_, x-staffpass-*-credential) is refused with
 * 403 ai_cannot_hold before anything else runs — an AI can neither stop nor release
 * (design §2.4 decision 8). The browser never sends those headers for a cookie session.
 */
import { jsonUtf8 } from "@/lib/http/json-utf8";
import { isDemoMode } from "@/lib/mode";
import { getSessionContext } from "@/lib/auth/session";
import { activeSessionMember } from "@/lib/auth/active-member";
import { resolveDemoActor } from "@/lib/team/demo-actor";
import { appendAuditEvent } from "@/lib/data/audit";
import { resolveAppOrigin } from "@/lib/app-url";
import type { HoldActor, HoldFailure } from "@/lib/safety/hold-actions";

const AI_HEADERS = ["authorization", "x-staffpass-credential", "x-staffpass-admin-credential", "x-api-key"] as const;

export function aiCredentialPresented(req: Request): boolean {
  return AI_HEADERS.some((h) => (req.headers.get(h) || "").trim().length > 0);
}

export async function refuseAiCredential(req: Request, route: string): Promise<Response | null> {
  if (!aiCredentialPresented(req)) return null;
  console.warn("employee_hold_ai_refused", { route });
  const session = await getSessionContext().catch(() => null);
  if (session?.orgId) {
    await appendAuditEvent({
      orgId: session.orgId, employeeId: null, credentialId: null, action: "employee.hold.ai_refused",
      purpose: "employee.hold.ai_refused", summary: "AI の資格情報での停止・解除を拒否しました",
      metadata: { auditClass: "admin", route },
    }).catch(() => undefined);
  }
  return jsonUtf8({ ok: false, error: "ai_cannot_hold", message: "AI は緊急停止・解除を操作できません。人がダッシュボードから操作してください。" }, { status: 403 });
}

/** The signed-in member as a web hold actor (demo: the demo actor; freshness via a demo-only header). */
export async function webMemberActor(req: Request, bodyActorId?: string | null): Promise<
  { ok: true; actor: Extract<HoldActor, { type: "member" }>; orgId: string } | { ok: false; response: Response }
> {
  if (isDemoMode()) {
    const member = resolveDemoActor(req, bodyActorId);
    const demoAuthTime = req.headers.get("x-demo-auth-time");
    return { ok: true, orgId: member.orgId, actor: { type: "member", member, surface: "web", authUserId: null, demoAuthTime: demoAuthTime || new Date().toISOString() } };
  }
  const session = await getSessionContext();
  const member = activeSessionMember(session);
  if (!member || !session.orgId || member.orgId !== session.orgId) {
    return { ok: false, response: jsonUtf8({ ok: false, error: "auth_required" }, { status: 401 }) };
  }
  return { ok: true, orgId: session.orgId, actor: { type: "member", member, surface: "web", authUserId: session.userId ?? null } };
}

export function holdFailureResponse(f: HoldFailure): Response {
  return jsonUtf8({ ok: false, error: f.code, ...(f.message ? { message: f.message } : {}) }, { status: f.httpStatus });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/**
 * CSRF guard for the stop / release POSTs (木村 10/12 08:31). The Origin header must be present
 * and equal to this request's origin or the app origin (a browser fetch POST always sends it;
 * "null" and a missing Origin are refused), and the body must be declared application/json
 * (text/plain / form posts are "simple" cross-site requests that skip CORS preflight).
 */
export function refuseUnsafeBrowserPost(req: Request): Response | null {
  const origin = (req.headers.get("origin") || "").trim();
  const allowed = new Set<string>();
  try { allowed.add(new URL(req.url).origin); } catch { /* ignore */ }
  try { allowed.add(new URL(resolveAppOrigin()).origin); } catch { /* ignore */ }
  const site = req.headers.get("sec-fetch-site");
  if (!origin || origin === "null" || !allowed.has(origin) || (site && site !== "same-origin")) {
    return jsonUtf8({ ok: false, error: "cross_origin_refused" }, { status: 403 });
  }
  const ct = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") {
    return jsonUtf8({ ok: false, error: "json_required" }, { status: 415 });
  }
  return null;
}
