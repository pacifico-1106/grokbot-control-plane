import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/mode";
import { createRouteSupabase } from "@/lib/auth/route-supabase";
import { authConfirmUrl } from "@/lib/app-url";
import {
  clientIp,
  isPlausibleEmail,
  isSameOriginRequest,
  rateKey,
  takeRateLimit,
} from "@/lib/auth/auth-flow";

export const runtime = "nodejs";

/** Supabase error code / class name (e.g. over_email_send_rate_limit, AuthApiError); anything else → "invalid". */
function safeErrorId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "invalid";
}

/**
 * "Forgot password" → Supabase resetPasswordForEmail with an explicit
 * redirectTo of <canonical>/auth/confirm (prod: https://staffpass.sealith.com/auth/confirm).
 * Always answers the same way (no account enumeration). Same-origin only,
 * rate limited per IP and per email.
 */
export async function POST(req: Request) {
  if (!isSameOriginRequest(req.headers, req.url)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const done = NextResponse.redirect(new URL("/auth/forgot?sent=1", req.url), 303);

  const form = await req.formData().catch(() => null);
  const email = String(form?.get("email") || "").trim().toLowerCase();
  if (!isPlausibleEmail(email)) {
    return NextResponse.redirect(new URL("/auth/forgot?error=email_invalid", req.url), 303);
  }

  const ipOk = takeRateLimit(`forgot:ip:${rateKey(clientIp(req.headers))}`, 5, 15 * 60_000);
  const emailOk = takeRateLimit(`forgot:email:${rateKey(email)}`, 3, 60 * 60_000);
  if (!ipOk) {
    return NextResponse.redirect(new URL("/auth/forgot?error=rate_limited", req.url), 303);
  }
  // Per-email limit is silent (same response) so it can't be used as an oracle.
  if (!emailOk || isDemoMode()) return done;

  const supabase = await createRouteSupabase();
  if (!supabase) return done;

  // PKCE client: with the token_hash Reset Password template the link is
  // /auth/confirm?token_hash=…&type=recovery; with the default template it is
  // /auth/confirm?code=… (verifier cookie set on this response; type defaults to recovery).
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: authConfirmUrl(),
  });
  if (error) {
    // Ids only: never the email, token, link or error.message (which can echo them).
    console.warn("[auth] resetPasswordForEmail failed", {
      status: typeof error.status === "number" ? error.status : null,
      code: safeErrorId((error as { code?: unknown }).code),
      name: safeErrorId(error.name),
    });
  }
  return done;
}
