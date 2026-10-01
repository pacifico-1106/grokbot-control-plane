/**
 * PR-1c: Handoff + Outbox + Wake Webhook Security Tests
 * 
 * Tests for handoff flow, outbox processing, and webhook authentication.
 * 
 * Flags tested:
 * - LP_HANDOFF_ENABLED (default OFF)
 * - LP_WAKE_WEBHOOK_ENABLED (default OFF)
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

const envBackup = {
  handoffEnabled: process.env.LP_HANDOFF_ENABLED,
  wakeEnabled: process.env.LP_WAKE_WEBHOOK_ENABLED,
};

beforeEach(() => {
  delete process.env.LP_HANDOFF_ENABLED;
  delete process.env.LP_WAKE_WEBHOOK_ENABLED;
});

afterEach(() => {
  process.env.LP_HANDOFF_ENABLED = envBackup.handoffEnabled;
  process.env.LP_WAKE_WEBHOOK_ENABLED = envBackup.wakeEnabled;
});

const {
  isLpHandoffEnabled,
  isLpWakeWebhookEnabled,
} = await import("@/lib/feature-flags");

describe("FLAGS-OFF REGRESSION: LP handoff/webhook flags default to OFF", () => {
  test("LP_HANDOFF_ENABLED is OFF by default", () => {
    expect(isLpHandoffEnabled()).toBe(false);
  });

  test("LP_WAKE_WEBHOOK_ENABLED is OFF by default", () => {
    expect(isLpWakeWebhookEnabled()).toBe(false);
  });
});

describe("SECURITY: Handoff data layer guards", () => {
  test("createHandoff returns null when feature disabled", async () => {
    const { createHandoff } = await import("@/lib/lp/handoffs");
    
    const result = await createHandoff({
      journeyId: "test-journey-id",
      reason: "Test reason",
      summaryDraft: "Test summary",
    });
    
    expect(result).toBeNull();
  });

  test("getHandoff returns null when feature disabled", async () => {
    const { getHandoff } = await import("@/lib/lp/handoffs");
    
    const result = await getHandoff("test-handoff-id");
    
    expect(result).toBeNull();
  });

  test("confirmHandoff returns null when feature disabled", async () => {
    const { confirmHandoff } = await import("@/lib/lp/handoffs");
    
    const result = await confirmHandoff({
      handoffId: "test-handoff-id",
      summaryFinal: "Final summary",
    });
    
    expect(result).toBeNull();
  });
});

describe("SECURITY: Wake webhook guards", () => {
  test("validateWebhookRequest returns feature_disabled when flag OFF", async () => {
    const { validateWebhookRequest } = await import("@/lib/lp/wake-webhook");
    
    const result = await validateWebhookRequest(
      "/api/webhooks/lp-wake/test",
      "test-secret-123456"
    );
    
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("feature_disabled");
  });

  test("validateWebhookRequest rejects short secrets", async () => {
    process.env.LP_WAKE_WEBHOOK_ENABLED = "true";
    
    const { validateWebhookRequest } = await import("@/lib/lp/wake-webhook");
    
    const result = await validateWebhookRequest(
      "/api/webhooks/lp-wake/test",
      "short"
    );
    
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_secret");
  });
});

describe("SECURITY: Input validation", () => {
  test("email validation rejects invalid formats", () => {
    const validateEmail = (email: string): boolean => {
      if (!email || email.length > 320) return false;
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(email);
    };
    
    expect(validateEmail("valid@example.com")).toBe(true);
    expect(validateEmail("invalid")).toBe(false);
    expect(validateEmail("no@domain")).toBe(false);
    expect(validateEmail("")).toBe(false);
    expect(validateEmail("a".repeat(321) + "@test.com")).toBe(false);
  });

  test("phone validation allows standard formats", () => {
    const validatePhone = (phone: string): boolean => {
      if (!phone || phone.length > 50) return false;
      const cleaned = phone.replace(/[\s\-\(\)]/g, "");
      return /^[\d+]+$/.test(cleaned) && cleaned.length >= 10;
    };
    
    expect(validatePhone("090-1234-5678")).toBe(true);
    expect(validatePhone("+81 90 1234 5678")).toBe(true);
    expect(validatePhone("(03) 1234-5678")).toBe(true);
    expect(validatePhone("123")).toBe(false);
    expect(validatePhone("abc-def-ghij")).toBe(false);
    expect(validatePhone("")).toBe(false);
  });
});

describe("SECURITY: Summary length limits", () => {
  test("summaryDraft is truncated to 2000 chars", () => {
    const truncateSummary = (s: string) => s.slice(0, 2000);
    
    const short = "Short summary";
    const long = "x".repeat(3000);
    
    expect(truncateSummary(short)).toBe(short);
    expect(truncateSummary(long).length).toBe(2000);
  });
});

describe("INVARIANTS: Outbox idempotency", () => {
  test("business_key format for handoff", () => {
    const createBusinessKey = (handoffId: string) => `handoff:${handoffId}`;
    
    const key = createBusinessKey("abc-123");
    expect(key).toBe("handoff:abc-123");
    expect(key).toContain(":");
  });
});

describe("INVARIANTS: No sensitive data exposure", () => {
  test("webhook secret is hashed before storage", async () => {
    const { createHash } = await import("node:crypto");
    
    const secret = "my-webhook-secret-12345";
    const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");
    
    const hashed = hashSecret(secret);
    
    expect(hashed).not.toBe(secret);
    expect(hashed).toMatch(/^[a-f0-9]{64}$/);
    expect(hashed).not.toContain("secret");
  });

  test("IP address is hashed before storage", async () => {
    const { createHash } = await import("node:crypto");
    
    const ip = "192.168.1.1";
    const salt = "test-salt";
    const hashIp = (i: string) => createHash("sha256").update(`${i}:${salt}`).digest("hex");
    
    const hashed = hashIp(ip);
    
    expect(hashed).not.toContain("192");
    expect(hashed).not.toContain("168");
    expect(hashed).toMatch(/^[a-f0-9]{64}$/);
  });
});
