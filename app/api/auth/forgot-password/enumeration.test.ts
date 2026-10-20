/**
 * AUTH_ENUMERATION_HARDENING_ENABLED (default OFF):
 * password-reset send quota must not be burned by a fake unused captcha token.
 *
 * Flag OFF = main: takeRateLimit runs before resetPasswordForEmail, so
 * captcha_failed still consumes the per-email 3/hour budget.
 * Flag ON: peek before send, reserve atomically, refund only pre-SMTP 4xx.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type FakeError = {
  status?: number;
  code?: unknown;
  name?: unknown;
  message?: string;
} | null;

let resetCalls: Array<{ email: string; opts: unknown }> = [];
let resetError: FakeError = null;
let resetHold: Promise<void> | null = null;
let resetThrow: Error | null = null;

mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/auth/route-supabase", () => ({
  createRouteSupabase: async () => ({
    auth: {
      resetPasswordForEmail: async (email: string, opts: unknown) => {
        resetCalls.push({ email, opts });
        if (resetHold) await resetHold;
        if (resetThrow) throw resetThrow;
        return { data: {}, error: resetError };
      },
    },
  }),
}));

const { POST } = await import("./route");
const { resetRateLimitsForTest } = await import("@/lib/auth/auth-flow");
const { resetPasswordResetTurnstileReplayForTest } = await import("@/lib/auth/password-reset-turnstile");
const { isAuthEnumerationHardeningEnabled } = await import("@/lib/feature-flags");

const BASE = "https://staffpass.sealith.com";
const EMAIL = "victim.person@example.co.jp";
const FLAG = "AUTH_ENUMERATION_HARDENING_ENABLED";
const SRC = readFileSync(resolve(import.meta.dir, "route.ts"), "utf8");

function post(email: string, extra: Record<string, string> = {}) {
  const body = new URLSearchParams({ email, ...extra });
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

beforeEach(() => {
  resetCalls = [];
  resetError = null;
  resetHold = null;
  resetThrow = null;
  resetRateLimitsForTest();
  resetPasswordResetTurnstileReplayForTest();
  delete process.env[FLAG];
  delete process.env.PASSWORD_RESET_TURNSTILE_ENABLED;
  delete process.env.SUPABASE_AUTH_CAPTCHA_ENABLED;
});
afterEach(() => {
  delete process.env[FLAG];
  delete process.env.PASSWORD_RESET_TURNSTILE_ENABLED;
  delete process.env.SUPABASE_AUTH_CAPTCHA_ENABLED;
});

describe("AUTH_ENUMERATION_HARDENING_ENABLED", () => {
  test("is OFF by default", () => {
    expect(isAuthEnumerationHardeningEnabled()).toBe(false);
  });

  test("accepts true/1/on/enabled", () => {
    for (const v of ["true", "1", "on", "enabled", "TRUE", " On "]) {
      process.env[FLAG] = v;
      expect(isAuthEnumerationHardeningEnabled()).toBe(true);
    }
  });
});

describe("flag OFF (main): send quota is consumed before GoTrue", () => {
  test("resetPasswordForEmail throw still propagates", async () => {
    resetThrow = new Error("socket hang up");
    await expect(POST(post(EMAIL))).rejects.toThrow("socket hang up");
    expect(resetCalls).toHaveLength(1);
  });

  test("captcha_failed burns the per-email 3/hour quota", async () => {
    resetError = { status: 400, code: "captcha_failed", name: "AuthApiError" };
    for (let i = 0; i < 3; i++) {
      const res = await POST(post(EMAIL));
      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
    }
    expect(resetCalls).toHaveLength(3);
    resetError = null;
    const fourth = await POST(post(EMAIL));
    expect(resetCalls).toHaveLength(3);
    expect(fourth.status).toBe(303);
    expect(locationOf(fourth)).toBe(`${BASE}/auth/forgot?sent=1`);
  });
});

describe("flag ON: peek before send, consume only after GoTrue success", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  test("captcha_failed does not consume the per-email quota", async () => {
    resetError = { status: 400, code: "captcha_failed", name: "AuthApiError" };
    for (let i = 0; i < 3; i++) {
      const res = await POST(post(EMAIL));
      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
    }
    expect(resetCalls).toHaveLength(3);
    resetError = null;
    const fourth = await POST(post(EMAIL));
    expect(resetCalls).toHaveLength(4);
    expect(fourth.status).toBe(303);
    expect(locationOf(fourth)).toBe(`${BASE}/auth/forgot?sent=1`);
  });

  test("unexpected_failure / 5xx keep the reservation consumed and still return sent=1", async () => {
    resetError = { status: 500, code: "unexpected_failure", name: "AuthApiError" };
    for (let i = 0; i < 3; i++) {
      const res = await POST(post(EMAIL));
      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
    }
    expect(resetCalls).toHaveLength(3);
    resetError = null;
    const fourth = await POST(post(EMAIL));
    expect(resetCalls).toHaveLength(3);
    expect(locationOf(fourth)).toBe(`${BASE}/auth/forgot?sent=1`);
  });

  test("unknown or timeout codes keep the reservation consumed", async () => {
    for (const err of [
      { status: 500, code: "smtp_blew_up", name: "AuthApiError" },
      { status: 408, code: "request_timeout", name: "AuthApiError" },
      { status: 500, name: "AuthRetryableFetchError" },
    ] as FakeError[]) {
      resetRateLimitsForTest();
      resetCalls = [];
      resetError = err;
      for (let i = 0; i < 3; i++) {
        expect(locationOf(await POST(post(EMAIL)))).toBe(`${BASE}/auth/forgot?sent=1`);
      }
      resetError = null;
      expect(resetCalls).toHaveLength(3);
      expect(locationOf(await POST(post(EMAIL)))).toBe(`${BASE}/auth/forgot?sent=1`);
      expect(resetCalls).toHaveLength(3);
    }
  });

  test("pre-send 4xx (validation_failed, over_email_send_rate_limit) refund the reservation", async () => {
    for (const err of [
      { status: 400, code: "validation_failed", name: "AuthApiError" },
      { status: 429, code: "over_email_send_rate_limit", name: "AuthApiError" },
    ] as FakeError[]) {
      resetRateLimitsForTest();
      resetCalls = [];
      resetError = err;
      for (let i = 0; i < 3; i++) {
        expect(locationOf(await POST(post(EMAIL)))).toBe(`${BASE}/auth/forgot?sent=1`);
      }
      expect(resetCalls).toHaveLength(3);
      resetError = null;
      expect(locationOf(await POST(post(EMAIL)))).toBe(`${BASE}/auth/forgot?sent=1`);
      expect(resetCalls).toHaveLength(4);
    }
  });

  test("resetPasswordForEmail throw → 303 sent=1 and keeps the reservation", async () => {
    resetThrow = new Error("socket hang up");
    for (let i = 0; i < 3; i++) {
      const res = await POST(post(EMAIL));
      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
    }
    expect(resetCalls).toHaveLength(3);
    resetThrow = null;
    const fourth = await POST(post(EMAIL));
    expect(resetCalls).toHaveLength(3);
    expect(locationOf(fourth)).toBe(`${BASE}/auth/forgot?sent=1`);
  });

  test("successful send consumes; 4th in the window is silent sent=1 and does not call GoTrue", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await POST(post(EMAIL));
      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
    }
    expect(resetCalls).toHaveLength(3);
    const fourth = await POST(post(EMAIL));
    expect(resetCalls).toHaveLength(3);
    expect(fourth.status).toBe(303);
    expect(locationOf(fourth)).toBe(`${BASE}/auth/forgot?sent=1`);
  });

  test("success and non-captcha failure still share the sent=1 response", async () => {
    const ok = await POST(post(EMAIL));
    resetRateLimitsForTest();
    resetError = { status: 500, code: "unexpected_failure", name: "AuthApiError" };
    const failed = await POST(post("someone.else@example.com"));
    expect(ok.status).toBe(303);
    expect(failed.status).toBe(303);
    expect(locationOf(ok)).toBe(`${BASE}/auth/forgot?sent=1`);
    expect(locationOf(failed)).toBe(`${BASE}/auth/forgot?sent=1`);
    expect(await ok.text()).toBe(await failed.text());
  });

  test("concurrent successes cannot exceed the per-email limit", async () => {
    let release!: () => void;
    resetHold = new Promise<void>((r) => {
      release = r;
    });
    const reqs = Array.from({ length: 5 }, () => POST(post(EMAIL)));
    await new Promise((r) => setTimeout(r, 30));
    expect(resetCalls.length).toBeLessThanOrEqual(3);
    release();
    const results = await Promise.all(reqs);
    expect(resetCalls).toHaveLength(3);
    for (const res of results) {
      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
    }
  });

  test("over-quota IP check still returns rate_limited and does not call GoTrue", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await POST(post(`user${i}@example.com`));
      expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
    }
    expect(resetCalls).toHaveLength(5);
    const sixth = await POST(post("user5@example.com"));
    expect(resetCalls).toHaveLength(5);
    expect(locationOf(sixth)).toBe(`${BASE}/auth/forgot?error=rate_limited`);
  });
});

describe("CAPTCHA → IP brake → siteverify order is unchanged", () => {
  test("POST body keeps captcha-ip, supabase captcha, siteverify, then send quotas", () => {
    const post = SRC.slice(SRC.indexOf("export async function POST"));
    const captchaIp = post.indexOf("forgot:captcha-ip:");
    const supabaseCaptcha = post.indexOf("evaluateSupabaseAuthCaptcha");
    const siteverify = post.indexOf("evaluatePasswordResetTurnstile");
    const sendIp = post.indexOf("forgot:ip:");
    const sendEmail = post.indexOf("forgot:email:");
    const gotrue = post.indexOf("resetPasswordForEmail");
    expect(captchaIp).toBeGreaterThan(-1);
    expect(supabaseCaptcha).toBeGreaterThan(captchaIp);
    expect(siteverify).toBeGreaterThan(supabaseCaptcha);
    expect(sendIp).toBeGreaterThan(siteverify);
    expect(sendEmail).toBeGreaterThan(sendIp);
    expect(gotrue).toBeGreaterThan(sendEmail);
  });
});
