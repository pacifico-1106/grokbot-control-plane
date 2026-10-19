/**
 * Password-reset Turnstile (DKIM replay / unauthenticated recover mail).
 *
 * Flag PASSWORD_RESET_TURNSTILE_ENABLED defaults OFF: identical to today
 * (resetPasswordForEmail, no CAPTCHA). When ON, missing token / failed
 * siteverify / missing Turnstile keys must not call Supabase. Responses
 * never reveal whether the mailbox exists; CAPTCHA failure may be shown.
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

const BASE = "https://staffpass.sealith.com";
const EMAIL = "victim.person@example.co.jp";
const OTHER = "someone.else@example.com";
const FLAG = "PASSWORD_RESET_TURNSTILE_ENABLED";

const logged: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function post(email: string, token?: string) {
  const body = new URLSearchParams({ email });
  if (token !== undefined) body.set("cf-turnstile-response", token);
  return new Request(`${BASE}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": "203.0.113.7" },
    body,
  });
}

function locationOf(res: Response): string {
  return res.headers.get("location") || "";
}

function expectSameResponse(a: Response, b: Response) {
  expect(a.status).toBe(b.status);
  expect(locationOf(a)).toBe(locationOf(b));
}

function expectNoAccountOracle(res: Response) {
  const loc = locationOf(res);
  expect(loc).not.toContain(EMAIL);
  expect(loc).not.toContain(OTHER);
  expect(loc).not.toContain("exists");
  expect(loc).not.toContain("unknown");
}

function expectNoSecretsLogged(token?: string) {
  const all = logged.join("\n");
  expect(all).not.toContain(EMAIL);
  expect(all).not.toContain(OTHER);
  expect(all).not.toContain("victim.person");
  if (token) expect(all).not.toContain(token);
}

beforeEach(() => {
  resetCalls = [];
  resetError = null;
  turnstileConfigured = true;
  verifyCalls = [];
  verifyResult = { success: true, action: "password_reset", hostname: "staffpass.sealith.com" };
  delete process.env[FLAG];
  resetRateLimitsForTest();
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
});
afterEach(() => {
  delete process.env[FLAG];
  Object.assign(console, originalConsole);
});

test("flag OFF: no token still calls Supabase once (today's path)", async () => {
  const res = await POST(post(EMAIL));
  expect(res.status).toBe(303);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(resetCalls).toHaveLength(1);
  expect(verifyCalls).toHaveLength(0);
});

test("flag OFF: missing Turnstile secret still calls Supabase (today's path)", async () => {
  turnstileConfigured = false;
  const res = await POST(post(EMAIL, "tok"));
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(resetCalls).toHaveLength(1);
  expect(verifyCalls).toHaveLength(0);
});

test("flag ON + missing token → no Supabase, captcha error only", async () => {
  process.env[FLAG] = "true";
  const res = await POST(post(EMAIL));
  expect(resetCalls).toHaveLength(0);
  expect(verifyCalls).toHaveLength(0);
  expect(res.status).toBe(303);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_required`);
  expectNoAccountOracle(res);
  expectNoSecretsLogged();
});

test("flag ON + blank token → no Supabase", async () => {
  process.env[FLAG] = "true";
  const res = await POST(post(EMAIL, "   "));
  expect(resetCalls).toHaveLength(0);
  expect(verifyCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_required`);
});

test("flag ON + siteverify failure → no Supabase, captcha error only", async () => {
  process.env[FLAG] = "true";
  verifyResult = { success: false, errorCodes: ["invalid-input-response"] };
  const res = await POST(post(EMAIL, "bad-tok"));
  expect(resetCalls).toHaveLength(0);
  expect(verifyCalls).toEqual(["bad-tok"]);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoAccountOracle(res);
});

test("flag ON + helper fail-open (not_configured) → no Supabase", async () => {
  process.env[FLAG] = "true";
  verifyResult = { success: true, errorCodes: ["not_configured"] };
  const res = await POST(post(EMAIL, "tok"));
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
});

test("flag ON + missing Turnstile secret → no Supabase, no siteverify", async () => {
  process.env[FLAG] = "true";
  turnstileConfigured = false;
  const res = await POST(post(EMAIL, "tok"));
  expect(resetCalls).toHaveLength(0);
  expect(verifyCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoAccountOracle(res);
});

test("flag ON + valid token → Supabase exactly once", async () => {
  process.env[FLAG] = "true";
  const res = await POST(post(EMAIL, "tok"));
  expect(verifyCalls).toEqual(["tok"]);
  expect(resetCalls).toHaveLength(1);
  expect(resetCalls[0].email).toBe(EMAIL);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?sent=1`);
});

test("flag ON: known vs unknown mailbox give the same captcha-fail response", async () => {
  process.env[FLAG] = "true";
  const missing = await POST(post(EMAIL));
  const other = await POST(post(OTHER));
  expectSameResponse(missing, other);
  expect(await missing.text()).toBe(await other.text());
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(missing)).toBe(`${BASE}/auth/forgot?error=turnstile_required`);
});

test("flag ON: known vs unknown mailbox give the same success response", async () => {
  process.env[FLAG] = "true";
  const ok = await POST(post(EMAIL, "tok"));
  resetError = { status: 400, code: "user_not_found", name: "AuthApiError", message: "x" };
  const unknown = await POST(post(OTHER, "tok"));
  expectSameResponse(ok, unknown);
  expect(await ok.text()).toBe(await unknown.text());
  expect(locationOf(ok)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(resetCalls.map((c) => c.email)).toEqual([EMAIL, OTHER]);
  const all = logged.join("\n");
  expect(all).not.toContain(EMAIL);
  expect(all).not.toContain(OTHER);
});

test("flag ON: token minted for another widget action is rejected", async () => {
  process.env[FLAG] = "true";
  verifyResult = { success: true, action: "signup", hostname: "staffpass.sealith.com" };
  const res = await POST(post(EMAIL, "tok-wrong-action"));
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoSecretsLogged("tok-wrong-action");
});

test("flag ON: missing action → no Supabase", async () => {
  process.env[FLAG] = "true";
  verifyResult = { success: true, hostname: "staffpass.sealith.com" };
  const res = await POST(post(EMAIL, "tok-no-action"));
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoSecretsLogged("tok-no-action");
});

test("flag ON: empty action → no Supabase", async () => {
  process.env[FLAG] = "true";
  verifyResult = { success: true, action: "", hostname: "staffpass.sealith.com" };
  const res = await POST(post(EMAIL, "tok-empty-action"));
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoSecretsLogged("tok-empty-action");
});

test("flag ON: missing hostname → no Supabase", async () => {
  process.env[FLAG] = "true";
  verifyResult = { success: true, action: "password_reset" };
  const res = await POST(post(EMAIL, "tok-no-host"));
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoSecretsLogged("tok-no-host");
});

test("flag ON: hostname not allowlisted → no Supabase", async () => {
  process.env[FLAG] = "true";
  verifyResult = { success: true, action: "password_reset", hostname: "evil.example" };
  const res = await POST(post(EMAIL, "tok-bad-host"));
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoSecretsLogged("tok-bad-host");
});

test("flag ON: captcha failures never fall through to sent=1", async () => {
  process.env[FLAG] = "true";
  for (let i = 0; i < 6; i++) {
    const res = await POST(post(EMAIL));
    expect(locationOf(res)).not.toContain("sent=1");
    expect(locationOf(res)).toMatch(/error=(turnstile_required|turnstile_failed|rate_limited)$/);
  }
  expect(resetCalls).toHaveLength(0);
  expectNoSecretsLogged();
});

test("flag ON: 3 token-less posts do not spend the send quota", async () => {
  process.env[FLAG] = "true";
  for (let i = 0; i < 3; i++) {
    const res = await POST(post(EMAIL));
    expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=turnstile_required`);
  }
  const ok = await POST(post(EMAIL, "tok-after-three"));
  expect(locationOf(ok)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(resetCalls).toHaveLength(1);
  expectNoSecretsLogged("tok-after-three");
});

test("flag ON: same token twice calls Supabase only once", async () => {
  process.env[FLAG] = "true";
  const first = await POST(post(EMAIL, "replay-tok"));
  const second = await POST(post(OTHER, "replay-tok"));
  expect(locationOf(first)).toBe(`${BASE}/auth/forgot?sent=1`);
  expect(resetCalls).toHaveLength(1);
  expect(locationOf(second)).not.toContain("sent=1");
  expect(locationOf(second)).toBe(`${BASE}/auth/forgot?error=turnstile_failed`);
  expectNoSecretsLogged("replay-tok");
});

test("JSON POST is email_invalid and never calls Supabase", async () => {
  process.env[FLAG] = "true";
  const res = await POST(
    new Request(`${BASE}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ email: EMAIL, turnstileToken: "tok-json", "cf-turnstile-response": "tok-json" }),
    })
  );
  expect(resetCalls).toHaveLength(0);
  expect(locationOf(res)).toBe(`${BASE}/auth/forgot?error=email_invalid`);
  expectNoSecretsLogged("tok-json");
});

test("flag ON: every captcha rejection path omits token and email from logs", async () => {
  process.env[FLAG] = "true";
  const cases: Array<{ token?: string; result?: typeof verifyResult; configured?: boolean }> = [
    { token: undefined },
    { token: "   " },
    { token: "tok-verify-fail", result: { success: false, errorCodes: ["invalid-input-response"] } },
    { token: "tok-not-configured", result: { success: true, errorCodes: ["not_configured"] } },
    { token: "tok-no-secret", configured: false },
  ];
  for (const c of cases) {
    logged.length = 0;
    turnstileConfigured = c.configured ?? true;
    verifyResult = c.result ?? { success: true, action: "password_reset", hostname: "staffpass.sealith.com" };
    await POST(post(EMAIL, c.token));
    expect(resetCalls).toHaveLength(0);
    expectNoSecretsLogged(c.token?.trim() || undefined);
  }
});
