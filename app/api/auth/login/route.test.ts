import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let signInCalls = 0;
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
mock.module("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      signInWithPassword: async () => {
        signInCalls++;
        return {
          data: { user: null },
          error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
        };
      },
    },
  }),
}));

const { POST, LOGIN_RATE_LIMITS } = await import("./route");
const { resetRateLimitsForTest } = await import("@/lib/auth/auth-flow");

const BASE = "https://staffpass.sealith.com";

function jsonLogin(email: string, password: string, extraHeaders: Record<string, string> = {}) {
  return new Request(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-real-ip": "203.0.113.9",
      ...extraHeaders,
    },
    body: JSON.stringify({ email, password }),
  });
}

beforeEach(() => {
  signInCalls = 0;
  resetRateLimitsForTest();
});
afterEach(() => resetRateLimitsForTest());

test("wrong password → 401 login_failed, Auth is called", async () => {
  const res = await POST(jsonLogin("owner@example.com", "wrong-password-1"));
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe("login_failed");
  expect(signInCalls).toBe(1);
});

test("same IP over the window → 429 and Auth is not called", async () => {
  for (let i = 0; i < LOGIN_RATE_LIMITS.perIp; i++) {
    const res = await POST(jsonLogin(`user${i}@example.com`, "wrong-password-1"));
    expect(res.status).toBe(401);
  }
  const blocked = await POST(jsonLogin("last@example.com", "wrong-password-1"));
  expect(blocked.status).toBe(429);
  expect((await blocked.json()).error).toBe("rate_limited");
  expect(signInCalls).toBe(LOGIN_RATE_LIMITS.perIp);
});

test("same email over the window → 429 even from distinct IPs", async () => {
  for (let i = 0; i < LOGIN_RATE_LIMITS.perEmail; i++) {
    const res = await POST(
      jsonLogin("target@example.com", "wrong-password-1", { "x-real-ip": `198.51.100.${i + 1}` })
    );
    expect(res.status).toBe(401);
  }
  const blocked = await POST(
    jsonLogin("target@example.com", "wrong-password-1", { "x-real-ip": "198.51.100.200" })
  );
  expect(blocked.status).toBe(429);
  expect(signInCalls).toBe(LOGIN_RATE_LIMITS.perEmail);
});

test("cf-connecting-ip does not pick a separate bucket from x-real-ip", async () => {
  for (let i = 0; i < LOGIN_RATE_LIMITS.perIp; i++) {
    await POST(
      jsonLogin(`user${i}@example.com`, "wrong-password-1", {
        "x-real-ip": "203.0.113.9",
        "cf-connecting-ip": `1.1.1.${i + 1}`,
      })
    );
  }
  const blocked = await POST(
    jsonLogin("last@example.com", "wrong-password-1", {
      "x-real-ip": "203.0.113.9",
      "cf-connecting-ip": "8.8.8.8",
    })
  );
  expect(blocked.status).toBe(429);
  expect(signInCalls).toBe(LOGIN_RATE_LIMITS.perIp);
});

test("empty credentials do not consume the login budget", async () => {
  const res = await POST(jsonLogin("", ""));
  expect(res.status).toBe(400);
  expect(signInCalls).toBe(0);
  const attempt = await POST(jsonLogin("owner@example.com", "wrong-password-1"));
  expect(attempt.status).toBe(401);
  expect(signInCalls).toBe(1);
});
