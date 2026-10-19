/**
 * SUPABASE_AUTH_CAPTCHA_ENABLED on POST /api/auth/signup.
 *
 * Local Turnstile (evaluateSignupGuard) always siteverifies — that is the
 * bot check that runs BEFORE admin.createUser / welcome mail. Flag ON adds a
 * second, unused token for the post-signup signInWithPassword.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

let created = 0;
let mailed = 0;
let verifyCalls: string[] = [];
let signInArgs: Array<{ email?: string; password?: string; options?: { captchaToken?: string } }> = [];
let turnstileConfigured = true;

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "production",
}));
mock.module("@/lib/auth/session", () => ({
  createOrgWithOwner: async () => {
    created++;
    return { userId: "u", orgId: "org-new", memberId: "m" };
  },
  provisionOrgForUser: async () => {
    created++;
    return { orgId: "org-new", memberId: "m", member: {} };
  },
}));
mock.module("@/lib/email", () => ({
  sendWelcomeEmail: async () => {
    mailed++;
    return { ok: true };
  },
  sendTrialStartedEmail: async () => {
    mailed++;
    return { ok: true };
  },
}));
mock.module("@/lib/lp/turnstile", () => ({
  getTurnstileConfig: () => (turnstileConfigured ? { secretKey: "s", siteKey: "k" } : null),
  verifyTurnstileToken: async (token: string) => {
    verifyCalls.push(token);
    return { success: true, action: "signup" };
  },
  getClientIp: () => "203.0.113.9",
}));
mock.module("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
const realSsr = await import("@supabase/ssr");
mock.module("@supabase/ssr", () => ({
  ...realSsr,
  createServerClient: () => ({
    auth: {
      signInWithPassword: async (creds: (typeof signInArgs)[number]) => {
        signInArgs.push(creds);
        return { data: { user: { id: "u" } }, error: null };
      },
    },
  }),
}));

const { POST } = await import("./route");

const FLAG = "SUPABASE_AUTH_CAPTCHA_ENABLED";
const LOCAL = "signup-local-token-aaaaaaaa";
const UNUSED = "signup-supabase-token-bbbbbbbb";

const logged: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function jsonReq(body: Record<string, unknown>) {
  return new Request("https://staffpass.test/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orgName: "株式会社テスト",
      email: "owner@test.example",
      password: "correct-horse",
      legal_agreement: "accepted",
      ...body,
    }),
  });
}

beforeEach(() => {
  created = 0;
  mailed = 0;
  verifyCalls = [];
  signInArgs = [];
  turnstileConfigured = true;
  delete process.env[FLAG];
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

function expectNoSecretsLogged() {
  const all = logged.join("\n");
  expect(all).not.toContain(LOCAL);
  expect(all).not.toContain(UNUSED);
}

describe("signup captcha flag OFF (main)", () => {
  test("still siteverifies the local token and signs in without options", async () => {
    const res = await POST(jsonReq({ turnstileToken: LOCAL }));
    expect(res.status).toBe(200);
    expect(created).toBe(1);
    expect(verifyCalls).toEqual([LOCAL]);
    expect(signInArgs).toHaveLength(1);
    expect(signInArgs[0]).toEqual({ email: "owner@test.example", password: "correct-horse" });
    expect("options" in signInArgs[0]).toBe(false);
  });

  test("a dedicated supabase token is not forwarded while OFF", async () => {
    await POST(jsonReq({ turnstileToken: LOCAL, supabaseCaptchaToken: UNUSED }));
    expect(signInArgs[0]?.options).toBeUndefined();
    expect(created).toBe(1);
  });
});

describe("signup captcha flag ON", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  test("local token is siteverified; unused token is passed to signInWithPassword", async () => {
    const res = await POST(jsonReq({ turnstileToken: LOCAL, supabaseCaptchaToken: UNUSED }));
    expect(res.status).toBe(200);
    expect(created).toBe(1);
    expect(verifyCalls).toEqual([LOCAL]);
    expect(verifyCalls).not.toContain(UNUSED);
    expect(signInArgs[0]).toEqual({
      email: "owner@test.example",
      password: "correct-horse",
      options: { captchaToken: UNUSED },
    });
    expectNoSecretsLogged();
  });

  test("missing unused token → nothing created, local token not consumed", async () => {
    const res = await POST(jsonReq({ turnstileToken: LOCAL }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("turnstile_required");
    expect(created + mailed).toBe(0);
    expect(verifyCalls).toHaveLength(0);
    expect(signInArgs).toHaveLength(0);
  });

  test("same token for both fields → reject before create (single-use)", async () => {
    const res = await POST(jsonReq({ turnstileToken: LOCAL, supabaseCaptchaToken: LOCAL }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("turnstile_failed");
    expect(created + mailed).toBe(0);
    expect(verifyCalls).toHaveLength(0);
    expect(signInArgs).toHaveLength(0);
    expectNoSecretsLogged();
  });

  test("HTML form reads cf-turnstile-supabase for the unused token", async () => {
    const form = new FormData();
    form.set("orgName", "株式会社テスト");
    form.set("email", "owner@test.example");
    form.set("password", "correct-horse");
    form.set("legal_agreement", "accepted");
    form.set("cf-turnstile-response", LOCAL);
    form.set("cf-turnstile-supabase", UNUSED);
    const res = await POST(new Request("https://staffpass.test/api/auth/signup", { method: "POST", body: form }));
    expect(res.status).toBe(303);
    expect(created).toBe(1);
    expect(signInArgs[0]?.options?.captchaToken).toBe(UNUSED);
    expect(verifyCalls).toEqual([LOCAL]);
  });
});
