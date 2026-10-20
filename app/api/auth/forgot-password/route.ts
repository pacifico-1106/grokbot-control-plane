import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/mode";
import { createRouteSupabase } from "@/lib/auth/route-supabase";
import { authConfirmUrl } from "@/lib/app-url";
import {
  clientIp,
  isPlausibleEmail,
  isSameOriginRequest,
  peekRateLimit,
  rateKey,
  releaseRateLimit,
  reserveRateLimit,
  takeRateLimit,
} from "@/lib/auth/auth-flow";
import {
  consumePasswordResetTurnstileToken,
  evaluatePasswordResetTurnstile,
  PASSWORD_RESET_CAPTCHA_IP_LIMIT,
  PASSWORD_RESET_CAPTCHA_IP_WINDOW_MS,
} from "@/lib/auth/password-reset-turnstile";
import {
  isAuthEnumerationHardeningEnabled,
  isPasswordResetTurnstileEnabled,
  isSupabaseAuthCaptchaEnabled,
} from "@/lib/feature-flags";
import {
  evaluateSupabaseAuthCaptcha,
  isGoTrueCaptchaFailed,
  passwordResetEmailOptions,
  readAuthCaptchaFields,
} from "@/lib/auth/supabase-auth-captcha";
import { isGoTrueRecoverPreSendError } from "@/lib/auth/gotrue-recover";
import { jsonUtf8 } from "@/lib/http/json-utf8";
import { getClientIp, getTurnstileConfig, verifyTurnstileToken } from "@/lib/lp/turnstile";

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
 * rate limited per IP and per email. Optional local Turnstile
 * (PASSWORD_RESET_TURNSTILE_ENABLED, default OFF) is fail-closed: missing
 * token / failed verify / missing keys never call Supabase.
 *
 * SUPABASE_AUTH_CAPTCHA_ENABLED (default OFF) forwards an unused token as
 * captchaToken. When both flags are ON, the local siteverify token is never
 * reused (Turnstile tokens are single-use).
 *
 * When either flag is ON, CAPTCHA runs after the email-format check and before
 * the send quotas (`forgot:ip:*` / `forgot:email:*`). CAPTCHA failures use a
 * separate IP brake and never fall through to sent=1.
 *
 * AUTH_ENUMERATION_HARDENING_ENABLED (default OFF): peek those send quotas
 * (no consume), then reserve atomically. Refund only GoTrue errors that are
 * decided before SMTP (captcha_failed and an allowlisted 4xx). 5xx,
 * unexpected_failure, timeouts, unknown codes, and throws keep the
 * reservation. A throw answers 303 sent=1 (flag OFF still surfaces it).
 */
export async function POST(req: Request) {
  if (!isSameOriginRequest(req.headers, req.url)) {
    return jsonUtf8({ error: "forbidden" }, { status: 403 });
  }
  const done = NextResponse.redirect(new URL("/auth/forgot?sent=1", req.url), 303);

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return NextResponse.redirect(new URL("/auth/forgot?error=email_invalid", req.url), 303);
  }

  const form = await req.formData().catch(() => null);
  const email = String(form?.get("email") || "").trim().toLowerCase();
  const captchaFields = readAuthCaptchaFields(form ?? new FormData());
  const turnstileToken = captchaFields.localToken;
  if (!isPlausibleEmail(email)) {
    return NextResponse.redirect(new URL("/auth/forgot?error=email_invalid", req.url), 303);
  }

  const localTurnstileOn = isPasswordResetTurnstileEnabled();
  const supabaseCaptchaOn = isSupabaseAuthCaptchaEnabled();

  if (localTurnstileOn || supabaseCaptchaOn) {
    const captchaIpOk = takeRateLimit(
      `forgot:captcha-ip:${rateKey(clientIp(req.headers))}`,
      PASSWORD_RESET_CAPTCHA_IP_LIMIT,
      PASSWORD_RESET_CAPTCHA_IP_WINDOW_MS
    );
    if (!captchaIpOk) {
      return NextResponse.redirect(new URL("/auth/forgot?error=rate_limited", req.url), 303);
    }
  }

  const supabaseCaptcha = evaluateSupabaseAuthCaptcha({
    enabled: supabaseCaptchaOn,
    localToken: captchaFields.localToken,
    supabaseToken: captchaFields.supabaseToken,
    localTokenSiteverified: localTurnstileOn,
  });
  if (!supabaseCaptcha.ok) {
    console.warn("[auth] password reset turnstile rejected", { error: supabaseCaptcha.error });
    return NextResponse.redirect(new URL(`/auth/forgot?error=${supabaseCaptcha.error}`, req.url), 303);
  }

  if (localTurnstileOn) {
    const guard = await evaluatePasswordResetTurnstile(
      { turnstileToken, clientIp: getClientIp(req) },
      {
        turnstileConfigured: () => getTurnstileConfig() !== null,
        verifyTurnstile: verifyTurnstileToken,
      }
    );
    if (!guard.ok) {
      console.warn("[auth] password reset turnstile rejected", { error: guard.error });
      return NextResponse.redirect(new URL(`/auth/forgot?error=${guard.error}`, req.url), 303);
    }
    if (!consumePasswordResetTurnstileToken(turnstileToken.trim())) {
      console.warn("[auth] password reset turnstile rejected", { error: "turnstile_failed" });
      return NextResponse.redirect(new URL("/auth/forgot?error=turnstile_failed", req.url), 303);
    }
  }

  const ipKey = `forgot:ip:${rateKey(clientIp(req.headers))}`;
  const emailKey = `forgot:email:${rateKey(email)}`;
  const hardening = isAuthEnumerationHardeningEnabled();
  let reservedIp: { resetAt: number } | null = null;
  let reservedEmail: { resetAt: number } | null = null;

  const refundReservation = () => {
    if (reservedIp) releaseRateLimit(ipKey, reservedIp.resetAt);
    if (reservedEmail) releaseRateLimit(emailKey, reservedEmail.resetAt);
  };

  if (hardening) {
    if (!peekRateLimit(ipKey, 5, 15 * 60_000)) {
      return NextResponse.redirect(new URL("/auth/forgot?error=rate_limited", req.url), 303);
    }
    // Per-email limit is silent (same response) so it can't be used as an oracle.
    if (!peekRateLimit(emailKey, 3, 60 * 60_000) || isDemoMode()) return done;
    reservedIp = reserveRateLimit(ipKey, 5, 15 * 60_000);
    reservedEmail = reserveRateLimit(emailKey, 3, 60 * 60_000);
    if (!reservedIp) {
      if (reservedEmail) releaseRateLimit(emailKey, reservedEmail.resetAt);
      return NextResponse.redirect(new URL("/auth/forgot?error=rate_limited", req.url), 303);
    }
    if (!reservedEmail) {
      releaseRateLimit(ipKey, reservedIp.resetAt);
      return done;
    }
  } else {
    const ipOk = takeRateLimit(ipKey, 5, 15 * 60_000);
    const emailOk = takeRateLimit(emailKey, 3, 60 * 60_000);
    if (!ipOk) {
      return NextResponse.redirect(new URL("/auth/forgot?error=rate_limited", req.url), 303);
    }
    // Per-email limit is silent (same response) so it can't be used as an oracle.
    if (!emailOk || isDemoMode()) return done;
  }

  const supabase = await createRouteSupabase();
  if (!supabase) {
    if (hardening) refundReservation();
    return done;
  }

  // PKCE client: with the token_hash Reset Password template the link is
  // /auth/confirm?token_hash=…&type=recovery; with the default template it is
  // /auth/confirm?code=… (verifier cookie set on this response; type defaults to recovery).
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(
      email,
      passwordResetEmailOptions(authConfirmUrl(), supabaseCaptcha.captchaToken)
    );
    if (error) {
      if (hardening && isGoTrueRecoverPreSendError(error)) {
        refundReservation();
      }
      // Ids only: never the email, token, link or error.message (which can echo them).
      console.warn("[auth] resetPasswordForEmail failed", {
        status: typeof error.status === "number" ? error.status : null,
        code: safeErrorId((error as { code?: unknown }).code),
        name: safeErrorId(error.name),
      });
      if (isGoTrueCaptchaFailed(error)) {
        return NextResponse.redirect(new URL("/auth/forgot?error=turnstile_failed", req.url), 303);
      }
    }
    return done;
  } catch (e) {
    if (hardening) {
      console.warn("[auth] resetPasswordForEmail failed", {
        status: null,
        code: null,
        name: "invalid",
      });
      return done;
    }
    throw e;
  }
}
