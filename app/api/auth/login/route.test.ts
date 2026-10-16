import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

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
const { isLoginRateLimitEnabled } = await import("@/lib/feature-flags");

const BASE = "https://staffpass.sealith.com";
const FLAGS = ["LOGIN_RATE_LIMIT_ENABLED", "IP_HASH_KEY"] as const;
const backup = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
const IP_HASH_FIXTURE = "test-login-ip-hash-key-0123456789";

function restoreEnv() {
  for (const k of FLAGS) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
}

function enableLimiter() {
  process.env.LOGIN_RATE_LIMIT_ENABLED = "1";
  process.env.IP_HASH_KEY = IP_HASH_FIXTURE;
}

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
  delete process.env.LOGIN_RATE_LIMIT_ENABLED;
  process.env.IP_HASH_KEY = IP_HASH_FIXTURE;
});
afterEach(() => {
  resetRateLimitsForTest();
  restoreEnv();
});

describe("LOGIN_RATE_LIMIT_ENABLED default OFF", () => {
  test("flag is OFF when unset", () => {
    expect(isLoginRateLimitEnabled()).toBe(false);
  });

  test("does not 429 or skip Auth after the ON-path budget", async () => {
    const over = LOGIN_RATE_LIMITS.perIp + LOGIN_RATE_LIMITS.perIpAccount + 3;
    for (let i = 0; i < over; i++) {
      const res = await POST(jsonLogin("owner@example.com", "wrong-password-1"));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("login_failed");
    }
    expect(signInCalls).toBe(over);
  });

  test("missing IP_HASH_KEY does not 503 while OFF", async () => {
    delete process.env.IP_HASH_KEY;
    const res = await POST(jsonLogin("owner@example.com", "wrong-password-1"));
    expect(res.status).toBe(401);
    expect(signInCalls).toBe(1);
  });
});

describe("LOGIN_RATE_LIMIT_ENABLED ON", () => {
  beforeEach(enableLimiter);

  test("wrong password → 401 login_failed, Auth is called", async () => {
    const res = await POST(jsonLogin("owner@example.com", "wrong-password-1"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("login_failed");
    expect(signInCalls).toBe(1);
  });

  test("same IP+account over the window → 429, Auth is not called, Retry-After set", async () => {
    for (let i = 0; i < LOGIN_RATE_LIMITS.perIpAccount; i++) {
      const res = await POST(jsonLogin("owner@example.com", "wrong-password-1"));
      expect(res.status).toBe(401);
    }
    const blocked = await POST(jsonLogin("owner@example.com", "wrong-password-1"));
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: string; message: string };
    expect(body.error).toBe("rate_limited");
    expect(body.message).toMatch(/待って/);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(signInCalls).toBe(LOGIN_RATE_LIMITS.perIpAccount);
  });

  test("same IP spraying many accounts → 429 at the per-IP cap", async () => {
    for (let i = 0; i < LOGIN_RATE_LIMITS.perIp; i++) {
      const res = await POST(jsonLogin(`user${i}@example.com`, "wrong-password-1"));
      expect(res.status).toBe(401);
    }
    const blocked = await POST(jsonLogin("last@example.com", "wrong-password-1"));
    expect(blocked.status).toBe(429);
    expect(signInCalls).toBe(LOGIN_RATE_LIMITS.perIp);
  });

  test("attacker cannot lock a victim out from a different IP (no account-only bucket)", async () => {
    for (let i = 0; i < LOGIN_RATE_LIMITS.perIpAccount; i++) {
      const res = await POST(
        jsonLogin("victim@example.com", "wrong-password-1", { "x-real-ip": `198.51.100.${i + 1}` })
      );
      expect(res.status).toBe(401);
    }
    const victimElsewhere = await POST(
      jsonLogin("victim@example.com", "wrong-password-1", { "x-real-ip": "198.51.100.200" })
    );
    expect(victimElsewhere.status).toBe(401);
    expect(signInCalls).toBe(LOGIN_RATE_LIMITS.perIpAccount + 1);
  });

  test("unknown vs known emails take the same 401 then 429 path (no enumeration)", async () => {
    const unknown: number[] = [];
    const known: number[] = [];
    for (let i = 0; i < LOGIN_RATE_LIMITS.perIpAccount + 1; i++) {
      unknown.push((await POST(jsonLogin("nobody@example.com", "wrong-password-1"))).status);
    }
    resetRateLimitsForTest();
    signInCalls = 0;
    for (let i = 0; i < LOGIN_RATE_LIMITS.perIpAccount + 1; i++) {
      known.push((await POST(jsonLogin("owner@example.com", "wrong-password-1"))).status);
    }
    expect(unknown).toEqual(known);
    expect(unknown.slice(0, LOGIN_RATE_LIMITS.perIpAccount).every((s) => s === 401)).toBe(true);
    expect(unknown[LOGIN_RATE_LIMITS.perIpAccount]).toBe(429);
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

  test("spoofed X-Forwarded-For prefix does not split the per-IP bucket", async () => {
    for (let i = 0; i < LOGIN_RATE_LIMITS.perIp; i++) {
      await POST(
        jsonLogin(`user${i}@example.com`, "wrong-password-1", {
          "x-real-ip": "203.0.113.9",
          "x-forwarded-for": `${i}.0.0.1, 203.0.113.9`,
        })
      );
    }
    const blocked = await POST(
      jsonLogin("last@example.com", "wrong-password-1", {
        "x-real-ip": "203.0.113.9",
        "x-forwarded-for": "9.9.9.9, 203.0.113.9",
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

  test("missing IP_HASH_KEY → 503 fail-closed, Auth is not called", async () => {
    delete process.env.IP_HASH_KEY;
    const res = await POST(jsonLogin("owner@example.com", "wrong-password-1"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("login_unavailable");
    expect(body.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("203.0.113.9");
    expect(signInCalls).toBe(0);
  });

  test("rate-limit log never includes raw IP or email", async () => {
    const dumped: string[] = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...args: unknown[]) => {
      dumped.push(JSON.stringify(args));
    };
    console.error = (...args: unknown[]) => {
      dumped.push(JSON.stringify(args));
    };
    try {
      for (let i = 0; i < LOGIN_RATE_LIMITS.perIpAccount + 1; i++) {
        await POST(jsonLogin("owner@example.com", "wrong-password-1"));
      }
    } finally {
      console.warn = warn;
      console.error = error;
    }
    const blob = dumped.join("\n");
    expect(blob).not.toContain("203.0.113.9");
    expect(blob).not.toContain("owner@example.com");
    expect(blob).not.toContain("wrong-password-1");
  });
});

test("login route keys with HMAC(IP_HASH_KEY) and is gated on the flag", () => {
  const src = readFileSync(path.join(process.cwd(), "app/api/auth/login/route.ts"), "utf8");
  expect(src).toContain("isLoginRateLimitEnabled");
  expect(src).toContain("hmacWithIpHashKey");
  expect(src).not.toMatch(/login:email:/);
  expect(src).not.toMatch(/console\.(?:info|warn|error|log)\([^;]*x-real-ip/);
});
