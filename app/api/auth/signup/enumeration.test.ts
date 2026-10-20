/**
 * AUTH_ENUMERATION_HARDENING_ENABLED (default OFF):
 * signup must not reveal whether the mailbox is already registered.
 *
 * Fail-first (3 tests) asked flag ON to reuse the new-signup success
 * envelope (JSON 200 {ok:true} / HTML 303 /app) without a session.
 * Current signup is createUser → signInWithPassword → /app, so that
 * envelope cannot be shared with an existing mailbox. Unification is
 * deferred; flag ON must not change signup until a product choice.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

const FLAG = "AUTH_ENUMERATION_HARDENING_ENABLED";

let created = 0;
let mailed = 0;
let provisioned = 0;
let signInCalls = 0;
let createError: Error | null = null;
let layer2: { ok: true } | { ok: false; outcome: string; reason: string; status: number; message: string } = {
  ok: true,
};

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "production",
}));
mock.module("@/lib/auth/session", () => ({
  createOrgWithOwner: async () => {
    if (createError) throw createError;
    created++;
    return { userId: "u", orgId: "org-new", memberId: "m" };
  },
  provisionOrgForUser: async () => {
    provisioned++;
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
  getTurnstileConfig: () => ({ secretKey: "s", siteKey: "k" }),
  verifyTurnstileToken: async () => ({ success: true, action: "signup" }),
  getClientIp: () => "203.0.113.9",
}));
mock.module("@/lib/signup/attempts", () => ({
  anySignupLayer2Enabled: () => true,
  createSupabaseSignupAttemptStore: () => ({}),
  fingerprintSignup: () => ({
    ipHash: "ip",
    uaHash: "ua",
    emailDomain: "test.example",
    emailNormHash: "em",
    signals: [],
  }),
  evaluateSignupLayer2: async () => layer2,
  recordSignupAttempt: async () => ({ ok: true }),
}));
mock.module("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));
const realSsr = await import("@supabase/ssr");
mock.module("@supabase/ssr", () => ({
  ...realSsr,
  createServerClient: () => ({
    auth: {
      signInWithPassword: async () => {
        signInCalls++;
        return { data: { user: null }, error: { message: "Invalid login credentials" } };
      },
    },
  }),
}));

const { POST } = await import("./route");
const { isAuthEnumerationHardeningEnabled } = await import("@/lib/feature-flags");

function jsonReq(body: Record<string, unknown> = {}) {
  return new Request("https://staffpass.test/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orgName: "株式会社テスト",
      email: "owner@test.example",
      password: "correct-horse",
      legal_agreement: "accepted",
      turnstileToken: "tok",
      ...body,
    }),
  });
}

function formReq() {
  const form = new FormData();
  form.set("orgName", "株式会社テスト");
  form.set("email", "owner@test.example");
  form.set("password", "correct-horse");
  form.set("legal_agreement", "accepted");
  form.set("cf-turnstile-response", "tok");
  return new Request("https://staffpass.test/api/auth/signup", { method: "POST", body: form });
}

beforeEach(() => {
  created = 0;
  mailed = 0;
  provisioned = 0;
  signInCalls = 0;
  createError = null;
  layer2 = { ok: true };
  delete process.env[FLAG];
  delete process.env.SIGNUP_DOMAIN_CHECK_ENABLED;
});
afterEach(() => {
  delete process.env[FLAG];
  delete process.env.SIGNUP_DOMAIN_CHECK_ENABLED;
});

describe("AUTH_ENUMERATION_HARDENING_ENABLED", () => {
  test("is OFF by default", () => {
    expect(isAuthEnumerationHardeningEnabled()).toBe(false);
  });
});

describe("flag OFF (main): existing mailbox is distinguishable", () => {
  test("email_exists → 409 既に登録, no org created", async () => {
    createError = new Error("email_exists:User already registered");
    const res = await POST(jsonReq());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe("email_exists");
    expect(String(body.message)).toContain("既に登録");
    expect(created).toBe(0);
    expect(mailed).toBe(0);
    expect(provisioned).toBe(0);
  });

  test("duplicate_normalized → 409 既に登録", async () => {
    layer2 = {
      ok: false,
      outcome: "duplicate_normalized",
      reason: "duplicate_normalized",
      status: 409,
      message: "このメールアドレスは既に登録されています。ログインしてください。",
    };
    const res = await POST(jsonReq());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe("duplicate_normalized");
    expect(String(body.message)).toContain("既に登録");
    expect(created).toBe(0);
    expect(mailed).toBe(0);
  });
});

describe("flag ON: signup unification deferred (sign-in-then-/app)", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  test("email_exists JSON stays 409 — cannot match new-signup 200 without a session", async () => {
    const fresh = await POST(jsonReq({ email: "fresh@test.example" }));
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).ok).toBe(true);

    createError = new Error("email_exists:User already registered");
    const existing = await POST(jsonReq());
    const existingBody = await existing.json();
    expect(existing.status).toBe(409);
    expect(existingBody.error).toBe("email_exists");
    expect(String(existingBody.message)).toContain("既に登録");
    expect(created).toBe(1);
    expect(provisioned).toBe(0);
  });

  test("email_exists HTML stays 409 — new signup is 303 /app after signInWithPassword", async () => {
    const fresh = await POST(formReq());
    expect(fresh.status).toBe(303);
    expect(new URL(fresh.headers.get("location") || "").pathname).toBe("/app");
    expect(signInCalls).toBe(1);

    createError = new Error("email_exists:User already registered");
    const existing = await POST(formReq());
    expect(existing.status).toBe(409);
    expect((await existing.json()).error).toBe("email_exists");
    expect(created).toBe(1);
  });

  test("duplicate_normalized stays 409 既に登録", async () => {
    layer2 = {
      ok: false,
      outcome: "duplicate_normalized",
      reason: "duplicate_normalized",
      status: 409,
      message: "このメールアドレスは既に登録されています。ログインしてください。",
    };
    const existing = await POST(jsonReq());
    const existingBody = await existing.json();
    expect(existing.status).toBe(409);
    expect(existingBody.error).toBe("duplicate_normalized");
    expect(String(existingBody.message)).toContain("既に登録");
    expect(created).toBe(0);
    expect(mailed).toBe(0);
  });
});
