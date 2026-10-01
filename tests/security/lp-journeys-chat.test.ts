/**
 * PR-1b: Journeys + Chat Turn Security Tests
 * 
 * Tests for guest session tokens, chat tools, and security invariants.
 * 
 * Flags tested:
 * - LP_JOURNEYS_ENABLED (default OFF)
 * - LP_CHAT_TOOLS_ENABLED (default OFF)
 * - LP_INQUIRY_BOT_PROTECTION_ENABLED (default OFF)
 * - LP_INQUIRY_RATE_LIMIT_ENABLED (default OFF)
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

const envBackup = {
  journeysEnabled: process.env.LP_JOURNEYS_ENABLED,
  chatToolsEnabled: process.env.LP_CHAT_TOOLS_ENABLED,
  botProtection: process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED,
  rateLimit: process.env.LP_INQUIRY_RATE_LIMIT_ENABLED,
  jwtSecret: process.env.LP_JWT_SECRET,
};

beforeEach(() => {
  delete process.env.LP_JOURNEYS_ENABLED;
  delete process.env.LP_CHAT_TOOLS_ENABLED;
  delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;
  delete process.env.LP_INQUIRY_RATE_LIMIT_ENABLED;
  process.env.LP_JWT_SECRET = "test-secret-for-testing-only-32chars!!";
});

afterEach(() => {
  process.env.LP_JOURNEYS_ENABLED = envBackup.journeysEnabled;
  process.env.LP_CHAT_TOOLS_ENABLED = envBackup.chatToolsEnabled;
  process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED = envBackup.botProtection;
  process.env.LP_INQUIRY_RATE_LIMIT_ENABLED = envBackup.rateLimit;
  if (envBackup.jwtSecret) {
    process.env.LP_JWT_SECRET = envBackup.jwtSecret;
  } else {
    delete process.env.LP_JWT_SECRET;
  }
});

const {
  isLpJourneysEnabled,
  isLpChatToolsEnabled,
  isLpInquiryBotProtectionEnabled,
  isLpInquiryRateLimitEnabled,
} = await import("@/lib/feature-flags");

const {
  generateGuestToken,
  signToken,
  formatGuestCookie,
} = await import("@/lib/lp/journeys");

const { ALLOWED_TOOLS, TOOL_DEFINITIONS } = await import("@/lib/lp/chat-tools");

describe("FLAGS-OFF REGRESSION: LP chat flags default to OFF", () => {
  test("LP_JOURNEYS_ENABLED is OFF by default", () => {
    expect(isLpJourneysEnabled()).toBe(false);
  });

  test("LP_CHAT_TOOLS_ENABLED is OFF by default", () => {
    expect(isLpChatToolsEnabled()).toBe(false);
  });

  test("LP_INQUIRY_BOT_PROTECTION_ENABLED is OFF by default", () => {
    expect(isLpInquiryBotProtectionEnabled()).toBe(false);
  });

  test("LP_INQUIRY_RATE_LIMIT_ENABLED is OFF by default", () => {
    expect(isLpInquiryRateLimitEnabled()).toBe(false);
  });
});

describe("SECURITY: Guest token generation", () => {
  test("generateGuestToken creates unique tokens", () => {
    const token1 = generateGuestToken();
    const token2 = generateGuestToken();
    
    expect(token1.token).not.toBe(token2.token);
    expect(token1.tokenHash).not.toBe(token2.tokenHash);
  });

  test("token and tokenHash are different", () => {
    const { token, tokenHash } = generateGuestToken();
    expect(token).not.toBe(tokenHash);
  });

  test("tokenHash is SHA-256 hex (64 chars)", () => {
    const { tokenHash } = generateGuestToken();
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("signToken produces HMAC signature different from input", () => {
    const { token } = generateGuestToken();
    const signed = signToken(token);
    expect(signed).not.toBe(token);
    // HMAC-SHA256 produces 64 hex chars
    expect(signed).toMatch(/^[a-f0-9]{64}$/);
  });

  test("formatGuestCookie has security attributes", () => {
    const { token } = generateGuestToken();
    const cookie = formatGuestCookie(token);
    
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("lp_guest=");
  });
});

describe("SECURITY: Chat tools allowlist", () => {
  test("ALLOWED_TOOLS only contains expected safe tools", () => {
    const expectedTools = [
      "knowledge_search",
      "catalog_get",
      "recommend_plan",
      "proposal_prepare",
      "handoff_offer",
      "order_status_get",
    ];
    
    expect(ALLOWED_TOOLS).toEqual(expectedTools);
  });

  test("no dangerous tools in allowlist", () => {
    const dangerousPatterns = [
      "exec", "eval", "shell", "system", "spawn",
      "file", "write", "delete", "admin", "sudo",
      "db", "sql", "query", "migrate", "truncate",
    ];
    
    for (const tool of ALLOWED_TOOLS) {
      for (const pattern of dangerousPatterns) {
        expect(tool.toLowerCase()).not.toContain(pattern);
      }
    }
  });

  test("TOOL_DEFINITIONS matches ALLOWED_TOOLS", () => {
    const defNames = TOOL_DEFINITIONS.map(d => d.function.name);
    expect(defNames.sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
});

describe("SECURITY: Tool definitions have proper schemas", () => {
  test("all tools have required name and description", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.type).toBe("function");
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
      expect(def.function.description.length).toBeGreaterThan(10);
    }
  });

  test("tool parameters are properly typed", () => {
    for (const def of TOOL_DEFINITIONS) {
      const params = def.function.parameters;
      expect(params.type).toBe("object");
      expect(typeof params.properties).toBe("object");
    }
  });

  test("knowledge_search has query parameter", () => {
    const ksTool = TOOL_DEFINITIONS.find(d => d.function.name === "knowledge_search");
    expect(ksTool).toBeTruthy();
    expect(ksTool!.function.parameters.properties.query).toBeTruthy();
    expect(ksTool!.function.parameters.required).toContain("query");
  });
});

describe("INVARIANTS: Cookie security", () => {
  test("cookie contains signature preventing tampering", () => {
    const { token } = generateGuestToken();
    const cookie = formatGuestCookie(token);
    // Cookie value should have both token and signature separated by dot
    expect(cookie).toContain(".");
    const valueMatch = cookie.match(/lp_guest=([^;]+)/);
    expect(valueMatch).toBeTruthy();
    const parts = valueMatch![1].split(".");
    expect(parts.length).toBe(2);
    // Signature should be different from token
    expect(parts[0]).not.toBe(parts[1]);
  });

  test("cookie does not expose signing key", () => {
    const { token } = generateGuestToken();
    const cookie = formatGuestCookie(token);
    // Key is used to create signature but never appears in output
    expect(cookie).not.toContain("GUEST_SIGNING_KEY");
    expect(cookie).not.toContain("fallback-key");
  });
});
