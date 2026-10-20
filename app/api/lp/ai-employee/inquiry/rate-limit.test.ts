/**
 * LP_INQUIRY_RATE_LIMIT_ENABLED wiring for the consult / inquiry API.
 * Flag default OFF: no extra limiter. ON: hashed-IP + global cap, 429 + Retry-After.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const inquiries: Array<Record<string, unknown>> = [];
const mails: Array<{ subject: string; html: string }> = [];

mock.module("@/lib/lp/inquiry-data", () => ({
  createInquiry: async (input: Record<string, unknown>) => {
    inquiries.push(input);
    return { id: "inq_1" };
  },
}));
mock.module("@/lib/lp/notification-outbox", () => ({
  enqueueNotification: async () => null,
  processOutboxEntry: async () => undefined,
}));
mock.module("@/lib/resend", () => ({
  renderStubHtml: (_t: string, body: string) => body,
  sendTransactionalEmail: async (m: { subject: string; html: string }) => {
    mails.push(m);
    return { ok: true, stub: true };
  },
}));

const ENV = [
  "AI_EMP_INQUIRY_NOTIFY_EMAIL",
  "LP_INQUIRY_DB_ENABLED",
  "LP_INQUIRY_BOT_PROTECTION_ENABLED",
  "LP_INQUIRY_RATE_LIMIT_ENABLED",
  "IP_HASH_KEY",
  "TURNSTILE_SECRET_KEY",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL = "sales@fixture.invalid";
process.env.IP_HASH_KEY = "test-inquiry-ip-hash-key-0123456789";

afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/lp/rate-limit");
const { isLpInquiryRateLimitEnabled } = await import("@/lib/feature-flags");

const base = {
  plan: "intern",
  company: "株式会社テスト",
  name: "山田",
  email: "taro@example.jp",
  useCase: "日報の下書きを任せたい",
};

function post(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://staffpass.example/api/lp/ai-employee/inquiry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.9",
        ...headers,
      },
      body: JSON.stringify({ ...base, ...extra }),
    })
  );
}

beforeEach(() => {
  inquiries.length = 0;
  mails.length = 0;
  resetRateLimits();
  delete process.env.LP_INQUIRY_DB_ENABLED;
  delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;
  delete process.env.LP_INQUIRY_RATE_LIMIT_ENABLED;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  process.env.IP_HASH_KEY = "test-inquiry-ip-hash-key-0123456789";
  process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL = "sales@fixture.invalid";
});

describe("LP_INQUIRY_RATE_LIMIT_ENABLED default OFF", () => {
  test("flag is OFF when unset", () => {
    expect(isLpInquiryRateLimitEnabled()).toBe(false);
  });

  test("does not 429 after the ON-path per-IP budget", async () => {
    for (let i = 0; i < 8; i++) {
      const res = await post();
      expect(res.status).toBe(200);
    }
    expect(mails.length).toBe(8);
  });

  test("missing IP_HASH_KEY does not 503 while OFF (bot protection also OFF)", async () => {
    delete process.env.IP_HASH_KEY;
    const res = await post();
    expect(res.status).toBe(200);
  });
});

describe("LP_INQUIRY_RATE_LIMIT_ENABLED ON", () => {
  beforeEach(() => {
    process.env.LP_INQUIRY_RATE_LIMIT_ENABLED = "1";
  });

  test("same hashed IP over the window → 429, Japanese message, Retry-After", async () => {
    const allowed: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post();
      allowed.push(res.status);
    }
    expect(allowed.every((s) => s === 200)).toBe(true);
    const blocked = await post();
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("rate_limited");
    expect(body.message).toMatch(/リクエストが多すぎます/);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(mails.length).toBe(5);
  });

  test("distinct IPs are separate buckets", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post({}, { "x-real-ip": "203.0.113.9" })).status).toBe(200);
    }
    expect((await post({}, { "x-real-ip": "198.51.100.7" })).status).toBe(200);
  });

  test("cf-connecting-ip / spoofed XFF prefix do not split the hashed-IP bucket", async () => {
    for (let i = 0; i < 5; i++) {
      await post(
        {},
        {
          "x-real-ip": "203.0.113.9",
          "cf-connecting-ip": `${i}.1.1.1`,
          "x-forwarded-for": `${i}.9.9.9, 203.0.113.9`,
        }
      );
    }
    const blocked = await post(
      {},
      {
        "x-real-ip": "203.0.113.9",
        "cf-connecting-ip": "8.8.8.8",
        "x-forwarded-for": "1.2.3.4, 203.0.113.9",
      }
    );
    expect(blocked.status).toBe(429);
  });

  test("global cap returns 429 even when each IP is under its own limit", async () => {
    let blocked = 0;
    for (let i = 0; i < 110; i++) {
      const octet = (i % 250) + 1;
      const res = await post({}, { "x-real-ip": `198.51.100.${octet}` });
      if (res.status === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
  });

  test("bot protection still runs (Turnstile required) after a allowed rate-limit slot", async () => {
    process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED = "1";
    process.env.TURNSTILE_SECRET_KEY = "ts-secret-for-test";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "ts-site-for-test";
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("turnstile_required");
    expect(mails.length).toBe(0);
  });

  test("missing IP_HASH_KEY → 503, nothing mailed", async () => {
    delete process.env.IP_HASH_KEY;
    const res = await post();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ip_hash_unavailable");
    expect(mails.length).toBe(0);
    expect(JSON.stringify(body)).not.toContain("203.0.113.9");
    expect(JSON.stringify(body)).not.toContain("taro@example.jp");
  });

  test("rate-limit log never includes raw IP or form PII", async () => {
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
      for (let i = 0; i < 6; i++) await post();
    } finally {
      console.warn = warn;
      console.error = error;
    }
    const blob = dumped.join("\n");
    expect(blob).not.toContain("203.0.113.9");
    expect(blob).not.toContain("taro@example.jp");
    expect(blob).not.toContain("山田");
    expect(blob).not.toContain("株式会社テスト");
  });
});

test("inquiry route is gated on LP_INQUIRY_RATE_LIMIT_ENABLED and uses the trusted IP helper", () => {
  const src = readFileSync(path.join(process.cwd(), "app/api/lp/ai-employee/inquiry/route.ts"), "utf8");
  expect(src).toContain("isLpInquiryRateLimitEnabled");
  expect(src).toContain("checkRateLimits");
});
