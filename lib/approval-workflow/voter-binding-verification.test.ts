/**
 * Tests for voter binding verification with Slack DM.
 * PR #129/131 audit fix: secret_not_configured error handling
 */
import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";

const originalEnv = { ...process.env };

describe("handleVerificationButtonClick secret error handling", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns secret_not_configured when VOTER_BINDING_SECRET is missing in production", async () => {
    mock.module("@/lib/mode", () => ({
      isDemoMode: () => false,
      isSupabaseConfigured: () => true,
      isStripeConfigured: () => false,
      isResendConfigured: () => false,
      runtimeModeLabel: () => "production",
    }));

    delete process.env.VOTER_BINDING_SECRET;

    const { handleVerificationButtonClick } = await import("./voter-binding-verification");

    const result = await handleVerificationButtonClick({
      callbackValue: "invalid.callback",
      presserSlackUserId: "U123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("secret_not_configured");
      expect(result.messageJa).toContain("シークレットが設定されていません");
    }
  });

  test("returns secret_not_configured when VOTER_BINDING_SECRET is dev-secret in production", async () => {
    mock.module("@/lib/mode", () => ({
      isDemoMode: () => false,
      isSupabaseConfigured: () => true,
      isStripeConfigured: () => false,
      isResendConfigured: () => false,
      runtimeModeLabel: () => "production",
    }));

    process.env.VOTER_BINDING_SECRET = "dev-secret";

    const { handleVerificationButtonClick } = await import("./voter-binding-verification");

    const result = await handleVerificationButtonClick({
      callbackValue: "invalid.callback",
      presserSlackUserId: "U123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("secret_not_configured");
    }
  });
});

describe("handleVerificationRejection secret error handling", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns secret_not_configured when VOTER_BINDING_SECRET is missing in production", async () => {
    mock.module("@/lib/mode", () => ({
      isDemoMode: () => false,
      isSupabaseConfigured: () => true,
      isStripeConfigured: () => false,
      isResendConfigured: () => false,
      runtimeModeLabel: () => "production",
    }));

    delete process.env.VOTER_BINDING_SECRET;

    const { handleVerificationRejection } = await import("./voter-binding-verification");

    const result = await handleVerificationRejection({
      callbackValue: "invalid.callback",
      presserSlackUserId: "U123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("secret_not_configured");
      expect(result.messageJa).toContain("シークレットが設定されていません");
    }
  });
});
