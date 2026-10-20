/**
 * LP_INQUIRY_RATE_LIMIT_ENABLED on POST /api/journeys (LP inquiry / chat start).
 * Flag OFF: unchanged (no limiter unless bot protection is already ON).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
mock.module("@/lib/lp/journeys", () => ({
  createJourney: async () => ({ id: "j1" }),
  generateGuestToken: () => ({ token: "guest_x", tokenHash: "h" }),
  generateCsrfToken: () => "csrf",
  formatGuestCookieValue: (t: string) => `${t}.sig`,
}));
mock.module("@/lib/lp/knowledge-base", () => ({ getPublishedRelease: async () => null }));

const ENV = [
  "IP_HASH_KEY",
  "LP_CHAT_ENABLED",
  "OPENAI_API_KEY",
  "LP_INQUIRY_BOT_PROTECTION_ENABLED",
  "LP_INQUIRY_RATE_LIMIT_ENABLED",
  "TURNSTILE_SECRET_KEY",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/lp/rate-limit");

function post(headers: Record<string, string> = {}) {
  return POST(
    new Request("https://x.example/api/journeys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.9",
        ...headers,
      },
      body: JSON.stringify({ aiDisclosureAccepted: true, privacyVersion: "2026-09" }),
    })
  );
}

beforeEach(() => {
  resetRateLimits();
  process.env.IP_HASH_KEY = "test-journeys-ip-hash-key-0123456789";
  process.env.LP_CHAT_ENABLED = "1";
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;
  delete process.env.LP_INQUIRY_RATE_LIMIT_ENABLED;
});

describe("LP_INQUIRY_RATE_LIMIT_ENABLED default OFF", () => {
  test("does not 429 after the ON-path per-IP budget", async () => {
    for (let i = 0; i < 8; i++) {
      expect((await post()).status).toBe(201);
    }
  });
});

describe("LP_INQUIRY_RATE_LIMIT_ENABLED ON", () => {
  beforeEach(() => {
    process.env.LP_INQUIRY_RATE_LIMIT_ENABLED = "1";
  });

  test("same hashed IP over the window → 429 + Retry-After (Japanese)", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post()).status).toBe(201);
    }
    const blocked = await post();
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: string; message: string };
    expect(body.error).toBe("rate_limited");
    expect(body.message).toMatch(/リクエストが多すぎます/);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  test("bot protection still requires Turnstile when both flags are ON", async () => {
    process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED = "1";
    process.env.TURNSTILE_SECRET_KEY = "ts-secret-for-test";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "ts-site-for-test";
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("turnstile_required");
  });
});

test("journeys route is gated on LP_INQUIRY_RATE_LIMIT_ENABLED", () => {
  const src = readFileSync(path.join(process.cwd(), "app/api/journeys/route.ts"), "utf8");
  expect(src).toContain("isLpInquiryRateLimitEnabled");
});
