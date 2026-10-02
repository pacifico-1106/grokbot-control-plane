import { beforeEach, describe, expect, test } from "bun:test";
import {
  destinationAfterVerify,
  isSameOriginRequest,
  parseEmailLinkType,
  parseTokenHash,
  renderConfirmInterstitial,
  resetRateLimitsForTest,
  takeRateLimit,
  validateNewPassword,
} from "./auth-flow";

const h = (o: Record<string, string>) => new Headers(o);

describe("email link parsing", () => {
  test("only invite / recovery / magiclink accepted", () => {
    expect(parseEmailLinkType("invite")).toBe("invite");
    expect(parseEmailLinkType("RECOVERY")).toBe("recovery");
    expect(parseEmailLinkType("magiclink")).toBe("magiclink");
    for (const t of ["signup", "email_change", "email", "", null, undefined, 1]) {
      expect(parseEmailLinkType(t)).toBeNull();
    }
  });
  test("token_hash charset is conservative (no HTML / URL smuggling)", () => {
    expect(parseTokenHash("a".repeat(56))).toBe("a".repeat(56));
    expect(parseTokenHash("pkce_" + "0f".repeat(28))).toBe("pkce_" + "0f".repeat(28));
    expect(parseTokenHash('abc"><script>')).toBeNull();
    expect(parseTokenHash("short")).toBeNull();
    expect(parseTokenHash("a".repeat(300))).toBeNull();
  });
  test("invite/recovery must set a password; magic link goes to /app", () => {
    expect(destinationAfterVerify("invite")).toBe("/auth/set-password?flow=invite");
    expect(destinationAfterVerify("recovery")).toBe("/auth/set-password?flow=recovery");
    expect(destinationAfterVerify("magiclink")).toBe("/app");
  });
});

describe("interstitial", () => {
  test("is a POST form to /auth/confirm, never auto-submits", () => {
    const html = renderConfirmInterstitial({ type: "invite", tokenHash: "a".repeat(56) });
    expect(html).toContain('method="post" action="/auth/confirm"');
    expect(html).toContain('name="token_hash" value="' + "a".repeat(56) + '"');
    expect(html).not.toContain("<script");
  });
});

describe("password validation", () => {
  test("min length, confirm, max bytes, weak", () => {
    expect(validateNewPassword("", "", null)).toBe("password_required");
    expect(validateNewPassword("short1", "short1", null)).toBe("password_too_short");
    expect(validateNewPassword("Long-enough-1", "Long-enough-2", null)).toBe("password_mismatch");
    expect(validateNewPassword("a".repeat(80), "a".repeat(80), null)).toBe("password_too_long");
    expect(validateNewPassword("aaaaaaaaaaaa", "aaaaaaaaaaaa", null)).toBe("password_weak");
    expect(validateNewPassword("t.yasaka-2026", "t.yasaka-2026", "t.yasaka@example.com")).toBe(
      "password_weak"
    );
    expect(validateNewPassword("correct horse battery", "correct horse battery", "x@example.com")).toBeNull();
  });
});

describe("CSRF same-origin check", () => {
  const url = "https://staffpass.sealith.com/api/auth/set-password";
  test("same origin allowed; cross-site / null rejected", () => {
    expect(isSameOriginRequest(h({ origin: "https://staffpass.sealith.com" }), url, "https://staffpass.sealith.com")).toBe(true);
    expect(isSameOriginRequest(h({ origin: "https://evil.example" }), url, "https://staffpass.sealith.com")).toBe(false);
    expect(isSameOriginRequest(h({ origin: "null" }), url, "https://staffpass.sealith.com")).toBe(false);
  });
  test("missing Origin requires Sec-Fetch-Site: same-origin", () => {
    expect(isSameOriginRequest(h({}), url, "https://staffpass.sealith.com")).toBe(false);
    expect(isSameOriginRequest(h({ "sec-fetch-site": "cross-site" }), url, "https://staffpass.sealith.com")).toBe(false);
    expect(isSameOriginRequest(h({ "sec-fetch-site": "same-origin" }), url, "https://staffpass.sealith.com")).toBe(true);
  });
});

describe("rate limit", () => {
  beforeEach(() => resetRateLimitsForTest());
  test("fixed window", () => {
    expect(takeRateLimit("k", 2, 1000, 0)).toBe(true);
    expect(takeRateLimit("k", 2, 1000, 1)).toBe(true);
    expect(takeRateLimit("k", 2, 1000, 2)).toBe(false);
    expect(takeRateLimit("k", 2, 1000, 1001)).toBe(true);
  });
});
