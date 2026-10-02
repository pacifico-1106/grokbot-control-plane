import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/mode";
import { createRouteSupabase } from "@/lib/auth/route-supabase";
import {
  AUTH_PAGE_HEADERS,
  clientIp,
  destinationAfterVerify,
  isSameOriginRequest,
  parseAuthCode,
  parseEmailLinkType,
  parseTokenHash,
  rateKey,
  renderConfirmInterstitial,
  takeRateLimit,
} from "@/lib/auth/auth-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Supabase email-link landing (Invite / Reset Password / Magic Link templates):
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite|recovery|magiclink
 *
 * GET renders an interstitial only (never consumes the one-time token, so mail
 * scanners / link previews can't burn it). POST (same-origin) verifies the
 * token server-side via verifyOtp and sets the session cookie — no tokens ever
 * land in a URL fragment or in client JS.
 *
 * Also accepts `?code=…&type=recovery` (PKCE redirectTo fallback while the
 * dashboard templates still use {{ .ConfirmationURL }}).
 */
function invalid(req: Request, reason = "link_invalid") {
  const url = new URL("/auth/forgot", req.url);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url, 303);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokenHash = parseTokenHash(url.searchParams.get("token_hash"));
  const code = tokenHash ? null : parseAuthCode(url.searchParams.get("code"));
  // token_hash requires an explicit type; a PKCE code only comes from our own
  // resetPasswordForEmail redirectTo, so it defaults to recovery.
  const type =
    parseEmailLinkType(url.searchParams.get("type")) ?? (code ? "recovery" : null);
  if (!type || (!tokenHash && !code)) return invalid(req);

  return new NextResponse(renderConfirmInterstitial({ type, tokenHash, code }), {
    status: 200,
    headers: { ...AUTH_PAGE_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(req: Request) {
  if (!isSameOriginRequest(req.headers, req.url)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!takeRateLimit(`confirm:${rateKey(clientIp(req.headers))}`, 10, 10 * 60_000)) {
    return invalid(req, "rate_limited");
  }

  const form = await req.formData().catch(() => null);
  const type = parseEmailLinkType(form?.get("type"));
  const tokenHash = parseTokenHash(form?.get("token_hash"));
  const code = tokenHash ? null : parseAuthCode(form?.get("code"));
  if (!type || (!tokenHash && !code)) return invalid(req);

  if (isDemoMode()) {
    return NextResponse.redirect(new URL("/app?demo=1", req.url), 303);
  }

  const supabase = await createRouteSupabase();
  if (!supabase) return invalid(req);

  const { error } = tokenHash
    ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    : await supabase.auth.exchangeCodeForSession(code!);

  if (error) {
    // Do not echo provider error text; expired / used / wrong-type all look the same.
    return invalid(req, "link_invalid");
  }

  return NextResponse.redirect(new URL(destinationAfterVerify(type), req.url), 303);
}
