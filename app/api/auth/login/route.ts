import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/mode";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { matchesSuperAdminAllowlist } from "@/lib/admin/allowlist";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { isSameOriginBrowserPost } from "@/lib/mcp-oauth/http";
import {
  clientIp,
  takeRateLimit,
} from "@/lib/auth/auth-flow";
import {
  loginErrorMessage,
  loginFailureSearchParams,
  type LoginErrorCode,
} from "@/lib/auth/login-errors";
import { isLoginRateLimitEnabled, isSupabaseAuthCaptchaEnabled } from "@/lib/feature-flags";
import { LOGIN_RATE_LIMITS } from "@/lib/auth/login-limits";
import { safeNextDestination as safeDestination } from "@/lib/auth/safe-next";
import {
  evaluateSupabaseAuthCaptcha,
  isGoTrueCaptchaFailed,
  passwordSignInCredentials,
  readAuthCaptchaFields,
} from "@/lib/auth/supabase-auth-captcha";
import { jsonUtf8 } from "@/lib/http/json-utf8";
import { hmacWithIpHashKey, isIpHashKeyMissingError } from "@/lib/security/ip-hash-key";

export const runtime = "nodejs";

function wantsJson(req: Request, contentType: string): boolean {
  const accept = req.headers.get("accept") || "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

function isRateLimited(error: { status?: number; message?: string; code?: string }): boolean {
  if (error.status === 429) return true;
  if (error.code === "over_request_rate_limit") return true;
  return /rate|too many/i.test(error.message || "");
}

function fail(
  req: Request,
  json: boolean,
  code: LoginErrorCode,
  status: number,
  email: string,
  next: string,
  extraHeaders?: Record<string, string>
) {
  if (json) {
    return jsonUtf8(
      { error: code, message: loginErrorMessage(code, status) },
      { status, headers: extraHeaders }
    );
  }
  const url = new URL("/login", req.url);
  url.search = loginFailureSearchParams({ code, email, next });
  const headers = extraHeaders ? new Headers(extraHeaders) : undefined;
  return NextResponse.redirect(url, { status: 303, headers });
}

export async function POST(req: Request) {
  // Login CSRF guard (MCP OAuth consent relies on "who is signed in").
  // Only while MCP_OAUTH_ENABLED is ON; requests without Origin (non-browser) pass.
  if (isMcpOAuthEnabled() && !isSameOriginBrowserPost(req, { requireOrigin: false })) {
    return jsonUtf8({ error: "origin_mismatch", message: "不正な送信元です。" }, { status: 403 });
  }
  const contentType = req.headers.get("content-type") || "";
  const json = wantsJson(req, contentType);
  let email = "";
  let password = "";
  let next = "/app";
  let captchaFields = { localToken: "", supabaseToken: "" };

  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    email = String(body.email || "").trim();
    password = String(body.password || "");
    next = safeDestination(String(body.next || "/app"), req.url);
    captchaFields = readAuthCaptchaFields(body);
  } else {
    const form = await req.formData();
    email = String(form.get("email") || "").trim();
    password = String(form.get("password") || "");
    next = safeDestination(String(form.get("next") || "/app"), req.url);
    captchaFields = readAuthCaptchaFields(form);
  }

  if (isDemoMode()) {
    const url = new URL(next, req.url);
    url.searchParams.set("demo", "1");
    if (json) {
      return jsonUtf8({
        ok: true,
        demo: true,
        next: `${url.pathname}${url.search}${url.hash}`,
      });
    }
    return NextResponse.redirect(url, 303);
  }

  if (!email || !password) {
    return fail(req, json, "credentials_required", 400, email, next);
  }

  if (isLoginRateLimitEnabled()) {
    let ipHmac: string;
    let accountHmac: string;
    try {
      ipHmac = hmacWithIpHashKey(`ip:${clientIp(req.headers)}`);
      accountHmac = hmacWithIpHashKey(`em:${email.toLowerCase()}`);
    } catch (err) {
      if (isIpHashKeyMissingError(err)) {
        console.error("[auth/login] IP_HASH_KEY not configured; refusing");
        return fail(req, json, "login_unavailable", 503, email, next);
      }
      throw err;
    }
    const pairOk = takeRateLimit(
      `login:${ipHmac}:${accountHmac}`,
      LOGIN_RATE_LIMITS.perIpAccount,
      LOGIN_RATE_LIMITS.perIpAccountWindowMs
    );
    const ipOk = takeRateLimit(
      `login:ip:${ipHmac}`,
      LOGIN_RATE_LIMITS.perIp,
      LOGIN_RATE_LIMITS.perIpWindowMs
    );
    if (!pairOk || !ipOk) {
      console.warn("[auth/login] rate_limited", { ipHash: ipHmac.slice(0, 8) });
      const retryAfterSec = Math.ceil(
        (pairOk ? LOGIN_RATE_LIMITS.perIpWindowMs : LOGIN_RATE_LIMITS.perIpAccountWindowMs) / 1000
      );
      return fail(req, json, "rate_limited", 429, email, next, {
        "Retry-After": String(retryAfterSec),
      });
    }
  }

  const captcha = evaluateSupabaseAuthCaptcha({
    enabled: isSupabaseAuthCaptchaEnabled(),
    localToken: captchaFields.localToken,
    supabaseToken: captchaFields.supabaseToken,
    localTokenSiteverified: false,
  });
  if (!captcha.ok) {
    return fail(
      req,
      json,
      captcha.error,
      captcha.error === "turnstile_required" ? 400 : 403,
      email,
      next
    );
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options as never);
          });
        },
      },
    }
  );

  const { data, error } = await supabase.auth.signInWithPassword(
    passwordSignInCredentials(email, password, captcha.captchaToken)
  );
  if (error) {
    if (isGoTrueCaptchaFailed(error)) {
      return fail(req, json, "turnstile_failed", 403, email, next);
    }
    const rateLimited = isRateLimited(error);
    return fail(
      req,
      json,
      rateLimited ? "rate_limited" : "login_failed",
      rateLimited ? 429 : 401,
      email,
      next
    );
  }

  const superAdmin = data.user && matchesSuperAdminAllowlist({
    userId: data.user.id,
    email: data.user.email || email,
    userIds: process.env.SUPER_ADMIN_USER_IDS,
    emails: process.env.SUPER_ADMIN_EMAILS,
  });
  const destination = next === "/app" && superAdmin ? "/admin" : next;

  if (json) {
    return jsonUtf8({ ok: true, demo: false, next: destination });
  }
  return NextResponse.redirect(new URL(destination, req.url), 303);
}
