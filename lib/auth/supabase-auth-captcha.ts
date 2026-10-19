/**
 * Unused Turnstile token for GoTrue when SUPABASE_AUTH_CAPTCHA_ENABLED is ON.
 *
 * Cloudflare redeemes each token once at siteverify (timeout-or-duplicate on
 * replay; 300s TTL). We therefore never siteverify a token we will pass as
 * captchaToken — signup / password-reset local guards keep their own token.
 *
 * @see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 * @see https://supabase.com/docs/guides/auth/auth-captcha
 */
export const SUPABASE_AUTH_CAPTCHA_FIELD = "cf-turnstile-supabase";
export const SUPABASE_AUTH_CAPTCHA_JSON_FIELD = "supabaseCaptchaToken";
export const SUPABASE_AUTH_CAPTCHA_ACTION = "supabase_auth";

function readField(source: FormData | Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const raw = source instanceof FormData ? source.get(key) : source[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return "";
}

export function readAuthCaptchaFields(source: FormData | Record<string, unknown>): {
  localToken: string;
  supabaseToken: string;
} {
  return {
    // JSON clients send turnstileToken; HTML widgets send cf-turnstile-response.
    // FormData keeps the password-reset HTML order (widget field first).
    localToken:
      source instanceof FormData
        ? readField(source, ["cf-turnstile-response", "turnstileToken"])
        : readField(source, ["turnstileToken", "cf-turnstile-response"]),
    supabaseToken: readField(source, [SUPABASE_AUTH_CAPTCHA_JSON_FIELD, SUPABASE_AUTH_CAPTCHA_FIELD]),
  };
}

/** Token eligible for GoTrue. Empty means "do not call Auth with captchaToken". */
export function unusedCaptchaTokenForSupabase(input: {
  localToken: string;
  supabaseToken: string;
  localTokenSiteverified: boolean;
}): string {
  const dedicated = (input.supabaseToken || "").trim();
  const local = (input.localToken || "").trim();
  if (input.localTokenSiteverified) {
    if (!dedicated || dedicated === local) return "";
    return dedicated;
  }
  return dedicated || local;
}

export function evaluateSupabaseAuthCaptcha(input: {
  enabled: boolean;
  localToken: string;
  supabaseToken: string;
  localTokenSiteverified: boolean;
}):
  | { ok: true; captchaToken?: string }
  | { ok: false; error: "turnstile_required" | "turnstile_failed" } {
  if (!input.enabled) return { ok: true };
  const local = (input.localToken || "").trim();
  const dedicated = (input.supabaseToken || "").trim();
  if (input.localTokenSiteverified && dedicated && local && dedicated === local) {
    return { ok: false, error: "turnstile_failed" };
  }
  const captchaToken = unusedCaptchaTokenForSupabase(input);
  if (!captchaToken) return { ok: false, error: "turnstile_required" };
  return { ok: true, captchaToken };
}

export function passwordSignInCredentials(
  email: string,
  password: string,
  captchaToken: string | undefined
): { email: string; password: string; options?: { captchaToken: string } } {
  const token = (captchaToken || "").trim();
  if (!token) return { email, password };
  return { email, password, options: { captchaToken: token } };
}

export function passwordResetEmailOptions(
  redirectTo: string,
  captchaToken: string | undefined
): { redirectTo: string; captchaToken?: string } {
  const token = (captchaToken || "").trim();
  if (!token) return { redirectTo };
  return { redirectTo, captchaToken: token };
}

/** Documented GoTrue code when CAPTCHA protection rejects the token. */
export function isGoTrueCaptchaFailed(error: { code?: unknown } | null | undefined): boolean {
  return error?.code === "captcha_failed";
}
