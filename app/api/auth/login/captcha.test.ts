/**
 * SUPABASE_AUTH_CAPTCHA_ENABLED on POST /api/auth/login.
 * Flag OFF: signInWithPassword({ email, password }) — identical to main.
 * Flag ON: require a Turnstile token, pass it as options.captchaToken, do not
 * siteverify it (single-use; Supabase redeems it).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

type SignInArg = { email?: string; password?: string; options?: { captchaToken?: string } };
let signInArgs: SignInArg[] = [];
let signInError: { status?: number; code?: string; message?: string } | null = null;

mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
mock.module("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      signInWithPassword: async (creds: SignInArg) => {
        signInArgs.push(creds);
        if (signInError) return { data: { user: null }, error: signInError };
        return { data: { user: { id: "u", email: creds.email } }, error: null };
      },
    },
  }),
}));

const { POST } = await import("./route");
const { resetRateLimitsForTest } = await import("@/lib/auth/auth-flow");

const BASE = "https://staffpass.sealith.com";
const FLAG = "SUPABASE_AUTH_CAPTCHA_ENABLED";
const TOKEN = "login-captcha-token-abcdefghijklmnopqrstuvwxyz";

const logged: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function jsonLogin(body: Record<string, unknown>) {
  return new Request(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-real-ip": "203.0.113.9",
    },
    body: JSON.stringify(body),
  });
}

function formLogin(fields: Record<string, string>) {
  const form = new URLSearchParams(fields);
  return new Request(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "x-real-ip": "203.0.113.9",
    },
    body: form,
  });
}

beforeEach(() => {
  signInArgs = [];
  signInError = null;
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
  resetRateLimitsForTest();
  Object.assign(console, originalConsole);
});

function expectNoTokenLogged() {
  const all = logged.join("\n");
  expect(all).not.toContain(TOKEN);
  expect(all).not.toContain("captchaToken");
}

describe("SUPABASE_AUTH_CAPTCHA_ENABLED default OFF", () => {
  test("signInWithPassword is { email, password } with no options", async () => {
    const res = await POST(jsonLogin({ email: "owner@example.com", password: "correct-horse" }));
    expect(res.status).toBe(200);
    expect(signInArgs).toHaveLength(1);
    expect(signInArgs[0]).toEqual({ email: "owner@example.com", password: "correct-horse" });
    expect("options" in signInArgs[0]).toBe(false);
  });

  test("a client-supplied token is ignored (not forwarded, not verified)", async () => {
    const res = await POST(
      jsonLogin({ email: "owner@example.com", password: "correct-horse", turnstileToken: TOKEN })
    );
    expect(res.status).toBe(200);
    expect(signInArgs[0]).toEqual({ email: "owner@example.com", password: "correct-horse" });
    expect(signInArgs[0]?.options).toBeUndefined();
    expectNoTokenLogged();
  });
});

describe("SUPABASE_AUTH_CAPTCHA_ENABLED ON", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  test("token → options.captchaToken, Auth is called", async () => {
    const res = await POST(
      jsonLogin({ email: "owner@example.com", password: "correct-horse", turnstileToken: TOKEN })
    );
    expect(res.status).toBe(200);
    expect(signInArgs).toHaveLength(1);
    expect(signInArgs[0]).toEqual({
      email: "owner@example.com",
      password: "correct-horse",
      options: { captchaToken: TOKEN },
    });
    expectNoTokenLogged();
  });

  test("form field cf-turnstile-response is forwarded", async () => {
    const res = await POST(
      formLogin({ email: "owner@example.com", password: "correct-horse", "cf-turnstile-response": TOKEN })
    );
    expect(res.status).toBe(303);
    expect(signInArgs[0]?.options?.captchaToken).toBe(TOKEN);
  });

  test("missing token → 400 turnstile_required, Auth is not called", async () => {
    const res = await POST(jsonLogin({ email: "owner@example.com", password: "correct-horse" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("turnstile_required");
    expect(signInArgs).toHaveLength(0);
    expectNoTokenLogged();
  });

  test("blank token → 400 turnstile_required, Auth is not called", async () => {
    const res = await POST(
      jsonLogin({ email: "owner@example.com", password: "correct-horse", turnstileToken: "  " })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("turnstile_required");
    expect(signInArgs).toHaveLength(0);
  });

  test("GoTrue captcha_failed → turnstile_failed, not a credential oracle", async () => {
    signInError = { status: 400, code: "captcha_failed", message: "captcha verification process failed" };
    const res = await POST(
      jsonLogin({ email: "owner@example.com", password: "correct-horse", turnstileToken: TOKEN })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("turnstile_failed");
    expect(body.message).toMatch(/確認に失敗/);
    expect(body.message).not.toContain("captcha_failed");
    expectNoTokenLogged();
  });
});

test("login route never siteverifies the token it forwards", () => {
  const src = readFileSync(path.join(process.cwd(), "app/api/auth/login/route.ts"), "utf8");
  expect(src).not.toContain("verifyTurnstileToken");
  expect(src).toContain("passwordSignInCredentials");
  expect(src).toContain("isSupabaseAuthCaptchaEnabled");
});
