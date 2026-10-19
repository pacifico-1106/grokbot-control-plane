/**
 * SIGNUP_RATE_LIMIT_REQUIRED_ENABLED: after the account is created,
 * if recordSignupAttempt (store.insert) fails, welcome / trial mail
 * must be 0. Same for recoverOrphanedAuthUser.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

let created = 0;
let provisioned = 0;
let mailed = 0;
let createThrows: string | null = null;

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "production",
}));
mock.module("@/lib/auth/session", () => ({
  createOrgWithOwner: async () => {
    if (createThrows) throw new Error(createThrows);
    created++;
    return { userId: "u", orgId: "org-new", memberId: "m" };
  },
  provisionOrgForUser: async () => {
    provisioned++;
    return { orgId: "org-recovered", memberId: "m", member: {} };
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
const realAttempts = await import("@/lib/signup/attempts");
mock.module("@/lib/signup/attempts", () => ({
  ...realAttempts,
  createSupabaseSignupAttemptStore: () => ({
    async insert() {
      throw new Error("db down");
    },
    async count() {
      return 0;
    },
  }),
}));
mock.module("@/lib/lp/turnstile", () => ({
  getTurnstileConfig: () => ({ secretKey: "s", siteKey: "k" }),
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

function jsonReq() {
  return new Request("https://staffpass.test/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
    body: JSON.stringify({
      orgName: "株式会社テスト",
      email: "owner@test.example",
      password: "correct-horse",
      legal_agreement: "accepted",
      turnstileToken: "tok",
    }),
  });
}

beforeEach(() => {
  created = 0;
  provisioned = 0;
  mailed = 0;
  createThrows = null;
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("REQUIRED ON + insert fails after account create → no mail", () => {
  test("happy path: account created, store.insert throws, mailed is 0", async () => {
    process.env[FLAG] = "true";
    const res = await POST(jsonReq());
    expect(res.status).toBe(200);
    expect(created).toBe(1);
    expect(mailed).toBe(0);
  });

  test("recoverOrphanedAuthUser: auth_ok_org_failed then provision, insert throws, mailed is 0", async () => {
    process.env[FLAG] = "true";
    createThrows = "auth_ok_org_failed:org insert failed";
    const res = await POST(jsonReq());
    expect(res.status).toBe(200);
    expect((await res.json()).recovered).toBe(true);
    expect(provisioned).toBe(1);
    expect(mailed).toBe(0);
  });
});
