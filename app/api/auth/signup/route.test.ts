import { beforeEach, describe, expect, mock, test } from "bun:test";

let created = 0;
let mailed = 0;
let turnstileConfigured = true;
let verifyResult: { success: boolean; action?: string; errorCodes?: string[] } = { success: true, action: "signup" };

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "production",
}));
mock.module("@/lib/auth/session", () => ({
  createOrgWithOwner: async () => { created++; return { userId: "u", orgId: "org-new", memberId: "m" }; },
  provisionOrgForUser: async () => { created++; return { orgId: "org-new", memberId: "m", member: {} }; },
}));
mock.module("@/lib/email", () => ({
  sendWelcomeEmail: async () => { mailed++; return { ok: true }; },
  sendTrialStartedEmail: async () => { mailed++; return { ok: true }; },
}));
mock.module("@/lib/lp/turnstile", () => ({
  getTurnstileConfig: () => (turnstileConfigured ? { secretKey: "s", siteKey: "k" } : null),
  verifyTurnstileToken: async () => verifyResult,
  getClientIp: () => "203.0.113.9",
}));
mock.module("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
const realSsr = await import("@supabase/ssr");
mock.module("@supabase/ssr", () => ({
  ...realSsr,
  createServerClient: () => ({ auth: { signInWithPassword: async () => ({ data: { user: { id: "u" } }, error: null }) } }),
}));

const { POST } = await import("./route");

function jsonReq(body: Record<string, unknown>) {
  return new Request("https://staffpass.test/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const good = {
  orgName: "株式会社テスト",
  email: "owner@test.example",
  password: "correct-horse",
  legal_agreement: "accepted",
  turnstileToken: "tok",
};

beforeEach(() => {
  created = 0;
  mailed = 0;
  turnstileConfigured = true;
  verifyResult = { success: true, action: "signup" };
});

describe("POST /api/auth/signup bot protection", () => {
  test("valid Turnstile → account created", async () => {
    const res = await POST(jsonReq(good));
    expect(res.status).toBe(200);
    expect(created).toBe(1);
  });

  test("observed bot payload (default company name + random referral, no token) creates nothing and sends no mail", async () => {
    const res = await POST(jsonReq({ ...good, orgName: "株式会社サンプル商事", referral_code: "OYTHXCTQOIWWDOQSQRBFD", turnstileToken: "" }));
    expect(res.status).toBe(400);
    expect(created).toBe(0);
    expect(mailed).toBe(0);
  });

  test("missing token → 400, nothing created", async () => {
    const res = await POST(jsonReq({ ...good, turnstileToken: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("turnstile_required");
    expect(created + mailed).toBe(0);
  });

  test("Turnstile keys missing → 503 fail-closed", async () => {
    turnstileConfigured = false;
    const res = await POST(jsonReq(good));
    expect(res.status).toBe(503);
    expect(created + mailed).toBe(0);
  });

  test("siteverify failure → 403", async () => {
    verifyResult = { success: false };
    expect((await POST(jsonReq(good))).status).toBe(403);
    expect(created + mailed).toBe(0);
  });

  test("honeypot filled → rejected", async () => {
    const res = await POST(jsonReq({ ...good, company_website: "x" }));
    expect(res.status).toBe(400);
    expect(created + mailed).toBe(0);
  });

  test("HTML form failure redirects back to /signup with a fixed code (no input echo)", async () => {
    const form = new FormData();
    form.set("orgName", "株式会社テスト");
    form.set("email", "owner@test.example");
    form.set("password", "correct-horse");
    form.set("legal_agreement", "accepted");
    form.set("referral_code", "<script>");
    const res = await POST(new Request("https://staffpass.test/api/auth/signup", { method: "POST", body: form }));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location") || "");
    expect(loc.pathname).toBe("/signup");
    expect(loc.searchParams.get("error")).toBe("invalid_referral_code");
    expect(loc.search).not.toContain("script");
    expect(created + mailed).toBe(0);
  });

  test("form posts read the implicit-render Turnstile field", async () => {
    const form = new FormData();
    form.set("orgName", "株式会社テスト");
    form.set("email", "owner@test.example");
    form.set("password", "correct-horse");
    form.set("legal_agreement", "accepted");
    form.set("cf-turnstile-response", "tok");
    const res = await POST(new Request("https://staffpass.test/api/auth/signup", { method: "POST", body: form }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") || "").pathname).toBe("/app");
    expect(created).toBe(1);
  });
});
