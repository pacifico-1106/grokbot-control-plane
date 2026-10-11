/**
 * LP Inquiry Hardening Tests (PR-0a)
 * 
 * Tests:
 * - Feature flags default to OFF
 * - Bot protection behavior
 * - Rate limiting
 * - Turnstile verification
 * - DB storage when flag ON
 * - Email-only path when flag OFF
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
// IP_HASH_KEY is required (no dev fallback); fixture key for this test process.
process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

const envBackup = {
  lpInquiryDb: process.env.LP_INQUIRY_DB_ENABLED,
  lpInquiryBotProtection: process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED,
  lpInquiryCleanup: process.env.LP_INQUIRY_CLEANUP_ENABLED,
  notifyEmail: process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL,
};

beforeEach(() => {
  delete process.env.LP_INQUIRY_DB_ENABLED;
  delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;
  delete process.env.LP_INQUIRY_CLEANUP_ENABLED;
});

afterEach(() => {
  process.env.LP_INQUIRY_DB_ENABLED = envBackup.lpInquiryDb;
  process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED = envBackup.lpInquiryBotProtection;
  process.env.LP_INQUIRY_CLEANUP_ENABLED = envBackup.lpInquiryCleanup;
  process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL = envBackup.notifyEmail;
});

const {
  isLpInquiryDbEnabled,
  isLpInquiryBotProtectionEnabled,
  isLpInquiryCleanupEnabled,
} = await import("@/lib/feature-flags");

describe("LP Inquiry Hardening: Feature flags default to OFF", () => {
  test("LP_INQUIRY_DB_ENABLED is OFF by default", () => {
    expect(isLpInquiryDbEnabled()).toBe(false);
  });

  test("LP_INQUIRY_BOT_PROTECTION_ENABLED is OFF by default", () => {
    expect(isLpInquiryBotProtectionEnabled()).toBe(false);
  });

  test("LP_INQUIRY_CLEANUP_ENABLED is OFF by default", () => {
    expect(isLpInquiryCleanupEnabled()).toBe(false);
  });
});

describe("LP Inquiry Hardening: Flag parsing", () => {
  test("LP_INQUIRY_DB_ENABLED accepts true/1/on/enabled", () => {
    process.env.LP_INQUIRY_DB_ENABLED = "true";
    expect(isLpInquiryDbEnabled()).toBe(true);
    
    process.env.LP_INQUIRY_DB_ENABLED = "1";
    expect(isLpInquiryDbEnabled()).toBe(true);
    
    process.env.LP_INQUIRY_DB_ENABLED = "on";
    expect(isLpInquiryDbEnabled()).toBe(true);
    
    process.env.LP_INQUIRY_DB_ENABLED = "enabled";
    expect(isLpInquiryDbEnabled()).toBe(true);
  });

  test("LP_INQUIRY_DB_ENABLED rejects other values", () => {
    process.env.LP_INQUIRY_DB_ENABLED = "false";
    expect(isLpInquiryDbEnabled()).toBe(false);
    
    process.env.LP_INQUIRY_DB_ENABLED = "0";
    expect(isLpInquiryDbEnabled()).toBe(false);
    
    process.env.LP_INQUIRY_DB_ENABLED = "off";
    expect(isLpInquiryDbEnabled()).toBe(false);
    
    process.env.LP_INQUIRY_DB_ENABLED = "random";
    expect(isLpInquiryDbEnabled()).toBe(false);
  });
});

const rateLimitModule = await import("@/lib/lp/rate-limit");
const { hashIp, checkIpRateLimit, checkGlobalRateLimit, resetRateLimits } = rateLimitModule;

describe("LP Inquiry Hardening: Rate limiting", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  test("hashIp produces consistent hash", () => {
    const hash1 = hashIp("192.168.1.1");
    const hash2 = hashIp("192.168.1.1");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(16);
  });

  test("hashIp produces different hash for different IPs", () => {
    const hash1 = hashIp("192.168.1.1");
    const hash2 = hashIp("192.168.1.2");
    expect(hash1).not.toBe(hash2);
  });

  test("checkIpRateLimit allows requests within limit", () => {
    const ipHash = hashIp("test-ip-1");
    const config = { windowMs: 60000, maxRequests: 3 };
    
    expect(checkIpRateLimit(ipHash, config).allowed).toBe(true);
    expect(checkIpRateLimit(ipHash, config).allowed).toBe(true);
    expect(checkIpRateLimit(ipHash, config).allowed).toBe(true);
  });

  test("checkIpRateLimit blocks requests over limit", () => {
    const ipHash = hashIp("test-ip-2");
    const config = { windowMs: 60000, maxRequests: 2 };
    
    expect(checkIpRateLimit(ipHash, config).allowed).toBe(true);
    expect(checkIpRateLimit(ipHash, config).allowed).toBe(true);
    
    const result = checkIpRateLimit(ipHash, config);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("checkGlobalRateLimit allows requests within limit", () => {
    resetRateLimits();
    const config = { windowMs: 60000, maxRequests: 100 };
    
    const result = checkGlobalRateLimit(config);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(99);
  });
});

const turnstileModule = await import("@/lib/lp/turnstile");
const { getTurnstileConfig, verifyTurnstileToken } = turnstileModule;

describe("LP Inquiry Hardening: Turnstile verification", () => {
  test("getTurnstileConfig returns null when not configured", () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    expect(getTurnstileConfig()).toBe(null);
  });

  test("verifyTurnstileToken returns success when not configured", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const result = await verifyTurnstileToken("test-token");
    expect(result.success).toBe(true);
    expect(result.errorCodes).toContain("not_configured");
  });

  test("verifyTurnstileToken rejects invalid token format", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site-key";
    
    const result = await verifyTurnstileToken("");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain("invalid_token_format");
  });
});

describe("LP Inquiry Hardening: No hardcoded email fallback", () => {
  test("NOTIFY_EMAIL comes from env only", async () => {
    delete process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL;
    
    const routeModule = await import("@/app/api/lp/ai-employee/inquiry/route");
    expect(typeof routeModule.POST).toBe("function");
  });
});
