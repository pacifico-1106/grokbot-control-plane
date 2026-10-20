/**
 * SUPABASE_AUTH_CAPTCHA_ENABLED on POST /api/auth/forgot-password.
 *
 * Local Turnstile (PASSWORD_RESET_TURNSTILE_ENABLED) still siteverifies when
 * that flag is ON. The Supabase flag adds an unused captchaToken on
 * resetPasswordForEmail and must not reuse the siteverified token.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type FakeError = { status?: number; code?: unknown; name?: unknown; message?: string } | null;
let resetCalls: Array<{ email: string; opts: unknown }> = [];
let resetError: FakeError = null;
let turnstileConfigured = true;
let verifyCalls: string[] = [];
let verifyResult: { success: boolean; action?: string; hostname?: string; errorCodes?: string[] } = {
  success: true,
  action: "password_reset",
  hostname: "staffpass.sealith.com",
};

mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/auth/route-supabase", () => ({
  createRouteSupabase: async () => ({
    auth: {
      resetPasswordForEmail: async (email: string, opts: unknown) => {
        resetCalls.push({ email, opts });
        return { data: {}, error: resetError };
      },
    },
  }),
}));
mock.module("@/lib/lp/turnstile", () => ({
  getTurnstileConfig: () => (turnstileConfigured ? { secretKey: "s", siteKey: "k" } : null),
  verifyTurnstileToken: async (token: string) => {
    verifyCalls.push(token);
    return verifyResult;
  },
  getClientIp: () => "203.0.113.7",
}));

const { POST } = await import("./route");
const { resetRateLimitsForTest } = await import("@/lib/auth/auth-flow");
const { resetPasswordResetTurnstileReplayForTest } = await import("@/lib/auth/password-reset-turnstile");

const BASE = "https://staffpass.sealith.com";
const EMAIL = "victim.person@example.co.jp";
const LOCAL_FLAG = "PASSWORD_RESET_TURNSTILE_ENABLED";
const SB_FLAG = "SUPABASE_AUTH_CAPTCHA_ENABLED";
const LOCAL = "reset-local-token-cccccccc";
const UNUSED = "reset-supabase-token-dddddddd";

const logged: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function post(email: string, fields: Record<string, string> = {}) {
  const body = new URLSearchParams({ email, ...fields });
  return new Request(`${BASE}/api/auth/forgot-password`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "x-forwarded-for": "203.0.113.7",
    },
    body,
  });
}

function locationOf(res: Response): string {
  return res.headers.get("location") || "";
}

function expectNoSecretsLogged() {
  const all = logged.join("\n");
  expect(all).not.toContain(EMAIL);
  expect(all).not.toContain(LOCAL);
  expect(all).not.toContain(UNUSED);
  expect(all).not.toContain("captchaToken");
}

beforeEach(() => {
  resetCalls = [];
  resetError = null;
  turnstileConfigured = true;
  verifyCalls = [];
  verifyResult = { success: true, action: "password_reset", hostname: "staffpass.sealith.com" };
  delete process.env[LOCAL_FLAG];
  delete process.env[SB_FLAG];
  resetRateLimitsForTest();
  resetPasswordResetTurnstileReplayForTest();
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
});
afterEach(() => {
  delete process.env[LOCAL_FLAG];
  delete process.env[SB_FLAG];
  Object.assign(console, originalConsole);
});

test("both flags OFF: resetPasswordForEmail options are { redirectTo } only", async () => {
  const res = await POST(post(EMAIL, { "cf-turnstile-response": LOCAL }));
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(resetCalls).toHaveLength(1);
  expect(Object.keys(resetCalls[0].opts as object)).toEqual(["redirectTo"]);
  expect(verifyCalls).toHaveLength(0);
});

test("supabase flag ON, local OFF: unused local field is forwarded, not siteverified", async () => {
  process.env[SB_FLAG] = "true";
  const res = await POST(post(EMAIL, { "cf-turnstile-response": UNUSED }));
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(verifyCalls).toHaveLength(0);
  expect(resetCalls).toHaveLength(1);
  const opts = resetCalls[0].opts as { redirectTo: string; captchaToken?: string };
  expect(opts.captchaToken).toBe(UNUSED);
  expect(opts.redirectTo).toMatch(/\/auth\/confirm$/);
  expectNoSecretsLogged();
});

test("supabase flag ON: token over 2048 chars → no Supabase, not truncated", async () => {
  process.env[SB_FLAG] = "true";
  const tooLong = "g".repeat(2049);
  const res = await POST(post(EMAIL, { "cf-turnstile-response": tooLong }));
  expect(resetCalls).toHaveLength(0);
  expect(verifyCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expect(logged.join("\n")).not.toContain("ggg");
});

test("supabase flag ON, local OFF: missing token → no Supabase, captcha error", async () => {
  process.env[SB_FLAG] = "true";
  const res = await POST(post(EMAIL));
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_required`);
  expectNoSecretsLogged();
});

test("both flags ON: siteverify local token, forward a distinct unused token", async () => {
  process.env[LOCAL_FLAG] = "true";
  process.env[SB_FLAG] = "true";
  const res = await POST(
    post(EMAIL, { "cf-turnstile-response": LOCAL, "cf-turnstile-supabase": UNUSED })
  );
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(verifyCalls).toEqual([LOCAL]);
  expect(resetCalls).toHaveLength(1);
  expect((resetCalls[0].opts as { captchaToken?: string }).captchaToken).toBe(UNUSED);
  expect((resetCalls[0].opts as { captchaToken?: string }).captchaToken).not.toBe(LOCAL);
  expectNoSecretsLogged();
});

test("both flags ON: same token twice → no resetPasswordForEmail", async () => {
  process.env[LOCAL_FLAG] = "true";
  process.env[SB_FLAG] = "true";
  const res = await POST(
    post(EMAIL, { "cf-turnstile-response": LOCAL, "cf-turnstile-supabase": LOCAL })
  );
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoSecretsLogged();
});

test("both flags ON: local ok but unused missing → no Supabase (token not reused)", async () => {
  process.env[LOCAL_FLAG] = "true";
  process.env[SB_FLAG] = "true";
  const res = await POST(post(EMAIL, { "cf-turnstile-response": LOCAL }));
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_required`);
});

test("supabase flag ON: GoTrue captcha_failed → turnstile_failed, not sent=1", async () => {
  process.env[SB_FLAG] = "true";
  resetError = { status: 400, code: "captcha_failed", name: "AuthApiError", message: "captcha failed" };
  const res = await POST(post(EMAIL, { "cf-turnstile-response": UNUSED }));
  expect(resetCalls).toHaveLength(1);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoSecretsLogged();
});

test("supabase flag ON: missing token does not spend the send quota", async () => {
  process.env[SB_FLAG] = "true";
  for (let i = 0; i < 3; i++) {
    const res = await POST(post(EMAIL));
    expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_required`);
  }
  const ok = await POST(post(EMAIL, { "cf-turnstile-response": UNUSED }));
  expect(locationOf(ok)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(resetCalls).toHaveLength(1);
});
