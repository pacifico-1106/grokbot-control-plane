/**
 * LP routes with IP_HASH_KEY missing: clear 503 (ip_hash_unavailable), nothing written.
 * Data modules are mocked to count writes.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const writes: string[] = [];

mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
mock.module("@/lib/lp/journeys", () => ({
  createJourney: async () => { writes.push("journey"); return { id: "j1" }; },
  generateGuestToken: () => ({ token: "guest_x", tokenHash: "h" }),
  generateCsrfToken: () => "csrf",
  formatGuestCookieValue: (t: string) => `${t}.sig`,
}));
mock.module("@/lib/lp/knowledge-base", () => ({ getPublishedRelease: async () => null }));
mock.module("@/lib/lp/guest-session", () => ({
  resolveGuestJourney: async () => ({ ok: true, journey: { id: "journey_1" } }),
}));
mock.module("@/lib/lp/handoffs", () => ({
  createHandoff: async () => { writes.push("handoff"); return { id: "h1", status: "pending_confirmation" }; },
  getHandoff: async () => null,
  confirmHandoff: async () => { writes.push("confirm"); return null; },
  cancelHandoff: async () => { writes.push("cancel"); return null; },
}));
mock.module("@/lib/lp/outbox-processor", () => ({
  enqueueHandoffNotification: async () => { writes.push("outbox"); return null; },
}));
mock.module("@/lib/lp/wake-webhook", () => ({
  validateWebhookRequest: async () => ({ valid: true, config: { id: "cfg_1" } }),
  recordWebhookEvent: async () => { writes.push("wake_event"); return { id: "e1", status: "received" }; },
  updateWebhookEventStatus: async () => { writes.push("wake_status"); },
}));
mock.module("@/lib/lp/inquiry-data", () => ({
  createInquiry: async () => { writes.push("inquiry"); return { id: "i1" }; },
}));
mock.module("@/lib/lp/notification-outbox", () => ({
  enqueueNotification: async () => { writes.push("notify"); return null; },
  processOutboxEntry: async () => undefined,
}));

const ENV = ["IP_HASH_KEY", "LP_CHAT_ENABLED", "OPENAI_API_KEY", "LP_INQUIRY_BOT_PROTECTION_ENABLED", "LP_HANDOFF_ENABLED", "LP_WAKE_WEBHOOK_ENABLED"];
const backup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

const journeys = await import("@/app/api/journeys/route");
const handoff = await import("@/app/api/lp/handoff/route");
const wake = await import("@/app/api/webhooks/lp-wake/[path]/route");
const inquiry = await import("@/app/api/lp/ai-employee/inquiry/route");

const IP_HEADERS = { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9", "x-vercel-forwarded-for": "203.0.113.9" };

beforeEach(() => {
  writes.length = 0;
  delete process.env.IP_HASH_KEY;
  process.env.LP_CHAT_ENABLED = "1";
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.LP_HANDOFF_ENABLED = "1";
  process.env.LP_WAKE_WEBHOOK_ENABLED = "1";
  delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;
});

async function expect503(res: Response) {
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: string; message: string };
  expect(body.error).toBe("ip_hash_unavailable");
  expect(body.message.length).toBeGreaterThan(0);
  expect(writes).toEqual([]);
}

describe("IP_HASH_KEY missing → 503, no write", () => {
  for (const value of [undefined, " ", "replace_me", "default_hash_key_for_dev"]) {
    test(`POST /api/journeys (key=${JSON.stringify(value)})`, async () => {
      if (value !== undefined) process.env.IP_HASH_KEY = value;
      const res = await journeys.POST(
        new Request("https://x.example/api/journeys", {
          method: "POST",
          headers: IP_HEADERS,
          body: JSON.stringify({ aiDisclosureAccepted: true, privacyVersion: "2026-09" }),
        })
      );
      await expect503(res);
    });
  }

  test("POST /api/journeys with bot protection ON → 503 before rate limiting", async () => {
    process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED = "true";
    const res = await journeys.POST(
      new Request("https://x.example/api/journeys", { method: "POST", headers: IP_HEADERS, body: JSON.stringify({ aiDisclosureAccepted: true, privacyVersion: "2026-09" }) })
    );
    await expect503(res);
  });

  test("POST /api/lp/handoff → 503, no handoff row", async () => {
    const res = await handoff.POST(
      new Request("https://x.example/api/lp/handoff", {
        method: "POST",
        headers: { ...IP_HEADERS, "x-csrf-token": "c" },
        body: JSON.stringify({ reason: "相談したい", summaryDraft: "x" }),
      }) as never
    );
    await expect503(res);
  });

  test("POST /api/webhooks/lp-wake/[path] → 503, no event recorded", async () => {
    const res = await wake.POST(
      new Request("https://x.example/api/webhooks/lp-wake/p1", {
        method: "POST",
        headers: { ...IP_HEADERS, "x-webhook-secret": "s" },
        body: JSON.stringify({ event_type: "ping" }),
      }) as never,
      { params: Promise.resolve({ path: "p1" }) }
    );
    await expect503(res);
  });

  test("POST /api/lp/ai-employee/inquiry with bot protection ON → 503, no inquiry", async () => {
    process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED = "true";
    const res = await inquiry.POST(
      new Request("https://x.example/api/lp/ai-employee/inquiry", { method: "POST", headers: IP_HEADERS, body: JSON.stringify({}) })
    );
    await expect503(res);
  });
});

describe("IP_HASH_KEY set → not 503 (unchanged)", () => {
  test("journeys / handoff / lp-wake proceed and write", async () => {
    process.env.IP_HASH_KEY = "route-test-ip-hash-key-0123456789";
    const j = await journeys.POST(
      new Request("https://x.example/api/journeys", { method: "POST", headers: IP_HEADERS, body: JSON.stringify({ aiDisclosureAccepted: true, privacyVersion: "2026-09" }) })
    );
    expect(j.status).toBe(201);
    const h = await handoff.POST(
      new Request("https://x.example/api/lp/handoff", { method: "POST", headers: { ...IP_HEADERS, "x-csrf-token": "c" }, body: JSON.stringify({ reason: "相談したい", summaryDraft: "x" }) }) as never
    );
    expect(h.status).toBe(200);
    const w = await wake.POST(
      new Request("https://x.example/api/webhooks/lp-wake/p1", { method: "POST", headers: { ...IP_HEADERS, "x-webhook-secret": "s" }, body: JSON.stringify({ event_type: "ping" }) }) as never,
      { params: Promise.resolve({ path: "p1" }) }
    );
    expect(w.status).not.toBe(503);
    expect(writes).toContain("journey");
    expect(writes).toContain("handoff");
    expect(writes).toContain("wake_event");
  });

  test("inquiry with bot protection OFF never hashes → unaffected by a missing key (not 503)", async () => {
    const res = await inquiry.POST(
      new Request("https://x.example/api/lp/ai-employee/inquiry", { method: "POST", headers: IP_HEADERS, body: JSON.stringify({}) })
    );
    expect(res.status).not.toBe(503);
  });
});
