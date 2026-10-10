/**
 * 2026-10-10 (木村): production Supabase has never sent a recovery email
 * (recovery_sent_at empty for everyone) and the failure log only had `status`.
 * When resetPasswordForEmail fails we also log error.code and error.name —
 * never the email, token, link or message. The response is always
 * /auth/forgot?sent=1 (anti-enumeration) and must not change.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type FakeError = { status?: number; code?: unknown; name?: unknown; message?: string; [k: string]: unknown } | null;
let resetCalls: Array<{ email: string; opts: unknown }> = [];
let resetError: FakeError = null;
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

const { POST } = await import("./route");
const { resetRateLimitsForTest } = await import("@/lib/auth/auth-flow");
const BASE = "https://staffpass.sealith.com";
const EMAIL = "victim.person@example.co.jp";
const TOKEN = "pkce_8f3a1b2c3d4e5f60718293a4b5c6d7e8";
const LINK = `${BASE}/auth/confirm?token_hash=${"e".repeat(56)}&type=recovery`;

const logged: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function post(email: string) {
  return new Request(`${BASE}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": "203.0.113.7" },
    body: new URLSearchParams({ email }),
  });
}

beforeEach(() => {
  resetCalls = [];
  resetError = null;
  logged.length = 0;
  resetRateLimitsForTest();
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
});
afterEach(() => Object.assign(console, originalConsole));

function expectNoSecretsLogged() {
  const all = logged.join("\n");
  expect(all).not.toContain(EMAIL);
  expect(all).not.toContain("victim.person");
  expect(all).not.toContain(TOKEN);
  expect(all).not.toContain("token_hash");
  expect(all).not.toContain("/auth/confirm");
}

test("failure log has status, code and name", async () => {
  resetError = { status: 500, code: "unexpected_failure", name: "AuthApiError", message: "Error sending recovery email" };
  const res = await POST(post(EMAIL));
  expect(resetCalls.length).toBe(1);
  const line = logged.find((l) => l.includes("resetPasswordForEmail failed"));
  expect(line).toBeDefined();
  expect(line).toContain('"status":500');
  expect(line).toContain('"code":"unexpected_failure"');
  expect(line).toContain('"name":"AuthApiError"');
  expect(res.headers.get("location")).toBe(`${BASE}/auth/forgot?sent=1`);
});

test("missing code / name → logged as null, not omitted", async () => {
  resetError = { status: 429, message: "x" };
  await POST(post(EMAIL));
  const line = logged.find((l) => l.includes("resetPasswordForEmail failed")) || "";
  expect(line).toContain('"status":429');
  expect(line).toContain('"code":null');
  expect(line).toContain('"name":null');
});

test("never logs the email, token, link or message even when the error carries them", async () => {
  resetError = {
    status: 400,
    code: "over_email_send_rate_limit",
    name: "AuthApiError",
    message: `Error sending recovery email to ${EMAIL}: ${LINK}`,
    email: EMAIL,
    token: TOKEN,
    link: LINK,
  };
  await POST(post(EMAIL));
  const line = logged.find((l) => l.includes("resetPasswordForEmail failed")) || "";
  expect(line).toContain('"code":"over_email_send_rate_limit"');
  expectNoSecretsLogged();
});

test("a code / name that is not a plain identifier (e.g. carries the email) is not logged verbatim", async () => {
  resetError = { status: 500, code: `bad ${EMAIL}`, name: `${LINK}`, message: "x" };
  await POST(post(EMAIL));
  const line = logged.find((l) => l.includes("resetPasswordForEmail failed")) || "";
  expect(line).toContain('"code":"invalid"');
  expect(line).toContain('"name":"invalid"');
  expectNoSecretsLogged();
});

test("anti-enumeration: success and failure give the identical sent=1 response", async () => {
  const ok = await POST(post(EMAIL));
  resetRateLimitsForTest();
  resetError = { status: 500, code: "unexpected_failure", name: "AuthApiError", message: "x" };
  const failed = await POST(post("someone.else@example.com"));
  for (const res of [ok, failed]) {
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/auth/forgot?sent=1`);
  }
  expect(await ok.text()).toBe(await failed.text());
  expect(resetCalls.map((c) => c.email)).toEqual([EMAIL, "someone.else@example.com"]);
  expect(Object.keys(resetCalls[0].opts as object)).toEqual(["redirectTo"]);
  expect(String((resetCalls[0].opts as { redirectTo: string }).redirectTo)).toMatch(/\/auth\/confirm$/);
  expectNoSecretsLogged();
});

test("success writes no log line", async () => {
  await POST(post(EMAIL));
  expect(logged.filter((l) => l.includes("resetPasswordForEmail"))).toEqual([]);
});
