/**
 * SIGNUP_RATE_LIMIT_REQUIRED_ENABLED on POST /api/auth/signup.
 * Flag OFF: welcome / trial mail still go out (today). Flag ON + no attempt
 * store: 503 fail-closed, no account, no mail.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

let created = 0;
let mailed = 0;
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
  getTurnstileConfig: () =>
    turnstileConfigured ? { secretKey: "s", siteKey: "k" } : null,
  verifyTurnstileToken: async () => ({ success: true, action: "signup" }),
  getClientIp: () => "203.0.113.9",
}));
mock.module("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));
const realSsr = await import("@supabase/ssr");
mock.module("@supabase/ssr", () => ({
  ...realSsr,
  createServerClient: () => ({
    auth: {
      signInWithPassword: async () => ({
        data: { user: { id: "u" } },
        error: null,
      }),
    },
  }),
}));

const { POST } = await import("./route");

const FLAG = "SIGNUP_RATE_LIMIT_REQUIRED_ENABLED";
const saved = process.env[FLAG];

function jsonReq(body: Record<string, unknown> = {}) {
  return new Request("https://staffpass.test/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
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

beforeEach(() => {
  created = 0;
  mailed = 0;
  turnstileConfigured = true;
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("SIGNUP_RATE_LIMIT_REQUIRED_ENABLED on signup route", () => {
  test("flag OFF: welcome + trial mail still sent (today)", async () => {
    const res = await POST(jsonReq());
    expect(res.status).toBe(200);
    expect(created).toBe(1);
    expect(mailed).toBe(2);
  });

  test("flag ON + no attempt store: 503, no account, no mail", async () => {
    process.env[FLAG] = "true";
    const res = await POST(jsonReq());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("signup_unavailable");
    expect(created).toBe(0);
    expect(mailed).toBe(0);
  });
});
