import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { defaultConsentDeps, processConsentDecision } from "@/lib/mcp-oauth/consent";
import { ridBindingClearCookie } from "@/lib/mcp-oauth/browser-binding";
import { isSameOriginBrowserPost, oauthErrorPage, redirect303 } from "@/lib/mcp-oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Consent decision (PR-5). Same-origin browser form POST only. Flag OFF → 404. */
export async function POST(req: Request) {
  if (!isMcpOAuthEnabled()) return new Response("Not Found", { status: 404 });
  if (!isSameOriginBrowserPost(req, { requireOrigin: true })) {
    return oauthErrorPage(403, "access_denied", "不正な送信元からのリクエストです。");
  }
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("application/x-www-form-urlencoded") && !ct.startsWith("multipart/form-data")) {
    return oauthErrorPage(415, "invalid_request", "フォームから送信してください。");
  }
  const form = await req.formData().catch(() => null);
  if (!form) return oauthErrorPage(400, "invalid_request", "フォームを読み取れませんでした。");
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };

  const out = await processConsentDecision(
    {
      rid: str("rid"),
      csrf: str("csrf"),
      decision: str("decision"),
      employeeId: str("employee_id"),
      confirmed: str("confirm") === "yes",
    },
    await defaultConsentDeps()
  );
  if (out.type === "page") {
    // Hardening 2b: any decision error ends this rid for this browser (restart from the client).
    const res = oauthErrorPage(out.status, out.error, out.messageJa);
    const rid = str("rid");
    if (rid && rid.length <= 128) res.headers.set("Set-Cookie", ridBindingClearCookie(rid));
    return res;
  }
  // rid is consumed → drop its browser-binding cookie.
  return redirect303(out.location, { "Set-Cookie": ridBindingClearCookie(str("rid")) });
}
