import { NextResponse, type NextRequest } from "next/server";
import { LP_REF_COOKIE, LP_REF_COOKIE_MAX_AGE, LP_REF_PARAM, lpPageHomePath, parseLpRef } from "@/lib/lp/lp-page";

const CORP_PATH = lpPageHomePath("ai-employee-corp");

/**
 * /lp/ai-employee-corp?ref=… → store a VALID ref in an HttpOnly cookie and redirect to the
 * same URL without `ref`, so the value never stays in the address bar, the Referer, history
 * or screenshots, and is never in page HTML. An invalid ref is dropped (no cookie) and the
 * URL is cleaned the same way; the raw value is never echoed. Returns null when there is
 * nothing to do (other paths, or no ref param).
 */
export function lpCorpRefResponse(request: NextRequest): NextResponse | null {
  const url = request.nextUrl;
  if (url.pathname !== CORP_PATH || !url.searchParams.has(LP_REF_PARAM)) return null;
  const ref = parseLpRef(url.searchParams.get(LP_REF_PARAM));
  const clean = url.clone();
  clean.searchParams.delete(LP_REF_PARAM);
  const res = NextResponse.redirect(clean, 307);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  if (ref) {
    res.cookies.set(LP_REF_COOKIE, ref, {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: LP_REF_COOKIE_MAX_AGE,
    });
  }
  return res;
}
