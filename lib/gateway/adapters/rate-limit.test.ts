/**
 * 429 = not sent (木村 #278 answers 3, 2026-10-05): the provider's wait is
 * surfaced as a clamped retryAfterSeconds. Retry-After (delta seconds or an
 * HTTP date) wins over x-rate-limit-reset (X: epoch seconds); a missing or
 * unreadable hint gets the default. Pure functions, no network.
 */
import { describe, expect, test } from "bun:test";
import {
  PROVIDER_RATE_LIMITED,
  RETRY_AFTER_DEFAULT_SECONDS,
  RETRY_AFTER_MAX_SECONDS,
  RETRY_AFTER_MIN_SECONDS,
  rateLimitWaitRemainingSeconds,
  rateLimitedBody,
  retryAfterSecondsFromHeaders,
} from "./rate-limit";

const NOW = Date.parse("2026-10-05T02:00:00.000Z");
const h = (init: Record<string, string>) => new Headers(init);

describe("retryAfterSecondsFromHeaders", () => {
  test("Retry-After delta seconds", () => {
    expect(retryAfterSecondsFromHeaders(h({ "Retry-After": "30" }), NOW)).toBe(30);
  });
  test("Retry-After HTTP date", () => {
    const at = new Date(NOW + 45_000).toUTCString();
    expect(retryAfterSecondsFromHeaders(h({ "retry-after": at }), NOW)).toBe(45);
  });
  test("x-rate-limit-reset epoch seconds (X)", () => {
    const reset = String(Math.floor(NOW / 1000) + 120);
    expect(retryAfterSecondsFromHeaders(h({ "x-rate-limit-reset": reset }), NOW)).toBe(120);
  });
  test("Retry-After wins over x-rate-limit-reset", () => {
    const reset = String(Math.floor(NOW / 1000) + 600);
    expect(retryAfterSecondsFromHeaders(h({ "Retry-After": "5", "x-rate-limit-reset": reset }), NOW)).toBe(5);
  });
  test("clamped to [min, max]; past reset → min", () => {
    expect(retryAfterSecondsFromHeaders(h({ "Retry-After": "999999" }), NOW)).toBe(RETRY_AFTER_MAX_SECONDS);
    expect(retryAfterSecondsFromHeaders(h({ "Retry-After": "0" }), NOW)).toBe(RETRY_AFTER_MIN_SECONDS);
    const past = String(Math.floor(NOW / 1000) - 50);
    expect(retryAfterSecondsFromHeaders(h({ "x-rate-limit-reset": past }), NOW)).toBe(RETRY_AFTER_MIN_SECONDS);
    expect(RETRY_AFTER_MIN_SECONDS).toBe(1);
    expect(RETRY_AFTER_MAX_SECONDS).toBe(3600);
  });
  test("missing / garbage → default", () => {
    expect(retryAfterSecondsFromHeaders(h({}), NOW)).toBe(RETRY_AFTER_DEFAULT_SECONDS);
    expect(retryAfterSecondsFromHeaders(h({ "Retry-After": "soon" }), NOW)).toBe(RETRY_AFTER_DEFAULT_SECONDS);
    expect(retryAfterSecondsFromHeaders(h({ "Retry-After": "-5" }), NOW)).toBe(RETRY_AFTER_DEFAULT_SECONDS);
  });
});

describe("rateLimitedBody (returned to the AI)", () => {
  test("code + retryable + wait + nextStep that names the wait", () => {
    const body = rateLimitedBody({ retryAfterSeconds: 42, providerError: "ratelimited" });
    expect(body).toMatchObject({
      ok: false,
      code: PROVIDER_RATE_LIMITED,
      error: PROVIDER_RATE_LIMITED,
      reasonCode: PROVIDER_RATE_LIMITED,
      retryable: true,
      nextAction: "retry_later",
      retryAfterSeconds: 42,
      providerError: "ratelimited",
    });
    expect(String(body.nextStep)).toContain("42 seconds");
    expect(String(body.nextStep)).toMatch(/Nothing was posted/);
    expect(String(body.message)).toContain("42");
  });
});

describe("rateLimitWaitRemainingSeconds (approved re-run gate)", () => {
  const at = new Date(NOW).toISOString();
  test("inside the wait → remaining seconds (rounded up)", () => {
    expect(rateLimitWaitRemainingSeconds({ ok: false, error: PROVIDER_RATE_LIMITED, retryAfterSeconds: 30, at }, NOW + 10_500)).toBe(20);
  });
  test("after the wait, other errors, success or nothing recorded → 0", () => {
    expect(rateLimitWaitRemainingSeconds({ ok: false, error: PROVIDER_RATE_LIMITED, retryAfterSeconds: 30, at }, NOW + 30_000)).toBe(0);
    expect(rateLimitWaitRemainingSeconds({ ok: false, error: "channel_not_found", retryAfterSeconds: 30, at }, NOW)).toBe(0);
    expect(rateLimitWaitRemainingSeconds({ ok: true, at }, NOW)).toBe(0);
    expect(rateLimitWaitRemainingSeconds(null, NOW)).toBe(0);
  });
  test("a stored wait is clamped too (a tampered / huge value cannot lock the approval)", () => {
    expect(rateLimitWaitRemainingSeconds({ ok: false, error: PROVIDER_RATE_LIMITED, retryAfterSeconds: 10 ** 9, at }, NOW)).toBe(RETRY_AFTER_MAX_SECONDS);
  });
});
