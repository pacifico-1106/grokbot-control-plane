import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { defaultConsentDeps, processConsentDecision } from "@/lib/mcp-oauth/consent";
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
  if (out.type === "page") return oauthErrorPage(out.status, out.error, out.messageJa);
  return redirect303(out.location);
}
