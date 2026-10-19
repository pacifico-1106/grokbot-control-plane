/**
 * Real verifyTurnstileToken (fetch stubbed). Timeout / 5xx /
 * timeout-or-duplicate must never call resetPasswordForEmail.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let resetCalls: Array<{ email: string }> = [];
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/auth/route-supabase", () => ({
  createRouteSupabase: async () => ({
    auth: {
      resetPasswordForEmail: async (email: string) => {
        resetCalls.push({ email });
        return { data: {}, error: null };
      },
    },
  }),
}));

const { POST } = await import("./route");
const { resetRateLimitsForTest } = await import("@/lib/auth/auth-flow");
const { resetPasswordResetTurnstileReplayForTest } = await import("@/lib/auth/password-reset-turnstile");

const BASE = "https://staffpass.sealith.com";
const EMAIL = "victim.person@example.co.jp";
const FLAG = "PASSWORD_RESET_TURNSTILE_ENABLED";
const originalFetch = globalThis.fetch;

const logged: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function post(email: string, token: string) {
  return new Request(`${BASE}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": "203.0.113.7" },
    body: new URLSearchParams({ email, "cf-turnstile-response": token }),
  });
}

function stubFetch(handler: (input: unknown, init?: RequestInit) => Promise<Response> | Response | never) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => handler(input, init)) as typeof fetch;
}

beforeEach(() => {
  resetCalls = [];
  resetRateLimitsForTest();
  resetPasswordResetTurnstileReplayForTest();
  process.env[FLAG] = "true";
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-turnstile-site";
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env[FLAG];
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  Object.assign(console, originalConsole);
});

function expectRejectedWithoutSupabase(token: string, loc: string) {
  expect(resetCalls).toHaveLength(0);
  expect(loc).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  const all = logged.join("\n");
  expect(all).not.toContain(EMAIL);
  expect(all).not.toContain(token);
  expect(all).not.toContain("test-turnstile-secret");
}

test("siteverify timeout → no Supabase", async () => {
  const token = "tok-timeout";
  stubFetch(() => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  });
  const res = await POST(post(EMAIL, token));
  expectRejectedWithoutSupabase(token, res.headers.get("location") || "");
});

test("siteverify 5xx → no Supabase", async () => {
  const token = "tok-5xx";
  stubFetch(() => new Response("upstream", { status: 503 }));
  const res = await POST(post(EMAIL, token));
  expectRejectedWithoutSupabase(token, res.headers.get("location") || "");
});

test("siteverify timeout-or-duplicate → no Supabase", async () => {
  const token = "tok-duplicate";
  stubFetch(
    () =>
      new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  const res = await POST(post(EMAIL, token));
  expectRejectedWithoutSupabase(token, res.headers.get("location") || "");
});
