/** Subscription TTL grant + the cap that shortens risky settings. */
import { afterEach, describe, expect, test } from "bun:test";
import { MCP_EVENTS_LIMITS, classifySubscriptionRisk, grantSubscriptionTtl } from "@/lib/mcp-events/policy";

const MIN = 60_000, HOUR = 3_600_000;
afterEach(() => { delete process.env.MCP_EVENTS_TRUSTED_RECEIVER_HOSTS; });

describe("risk classification", () => {
  test("unlisted receiver host, high-risk approvals included and no-expiry requests are elevated", () => {
    const r = classifySubscriptionRisk({ host: "hooks.example.com", args: {}, requestedTtlMs: null });
    expect(r.risk).toBe("elevated");
    expect(r.reasons.sort()).toEqual(["includes_high_risk_approvals", "no_expiry_requested", "receiver_not_allowlisted"]);
  });
  test("allowlisted host + low/medium filter + finite TTL is standard", () => {
    process.env.MCP_EVENTS_TRUSTED_RECEIVER_HOSTS = "hooks.example.com, other.example.net";
    const r = classifySubscriptionRisk({ host: "HOOKS.example.com", args: { risk: ["low", "medium"] }, requestedTtlMs: HOUR });
    expect(r).toEqual({ risk: "standard", reasons: [] });
  });
  test("allowlist is exact host match (no suffix tricks)", () => {
    process.env.MCP_EVENTS_TRUSTED_RECEIVER_HOSTS = "example.com";
    expect(classifySubscriptionRisk({ host: "evil-example.com", args: { risk: ["low"] }, requestedTtlMs: HOUR }).reasons).toEqual(["receiver_not_allowlisted"]);
    expect(classifySubscriptionRisk({ host: "a.example.com", args: { risk: ["low"] }, requestedTtlMs: HOUR }).reasons).toEqual(["receiver_not_allowlisted"]);
  });
});

describe("TTL grant (refreshBefore is always finite)", () => {
  test("standard: default 1h, honours shorter requests, max 24h, floor 5 min", () => {
    expect(grantSubscriptionTtl({ requestedTtlMs: undefined, risk: "standard" }).ttlMs).toBe(HOUR);
    expect(grantSubscriptionTtl({ requestedTtlMs: 30 * MIN, risk: "standard" }).ttlMs).toBe(30 * MIN);
    expect(grantSubscriptionTtl({ requestedTtlMs: 7 * 24 * HOUR, risk: "standard" })).toEqual({ ttlMs: 24 * HOUR, capped: true });
    expect(grantSubscriptionTtl({ requestedTtlMs: 1000, risk: "standard" }).ttlMs).toBe(5 * MIN);
    expect(grantSubscriptionTtl({ requestedTtlMs: null, risk: "standard" })).toEqual({ ttlMs: 24 * HOUR, capped: true });
  });
  test("elevated: default 15 min, capped at 1h", () => {
    expect(grantSubscriptionTtl({ requestedTtlMs: undefined, risk: "elevated" }).ttlMs).toBe(15 * MIN);
    expect(grantSubscriptionTtl({ requestedTtlMs: 24 * HOUR, risk: "elevated" })).toEqual({ ttlMs: HOUR, capped: true });
    expect(grantSubscriptionTtl({ requestedTtlMs: null, risk: "elevated" })).toEqual({ ttlMs: HOUR, capped: true });
  });
  test("garbage TTL falls back to the default (never no-expiry)", () => {
    for (const v of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(grantSubscriptionTtl({ requestedTtlMs: v, risk: "standard" }).ttlMs).toBe(HOUR);
    }
  });
  test("limits are exported for the design doc", () => {
    expect(MCP_EVENTS_LIMITS.maxSubscriptionsPerEmployee).toBe(20);
    expect(MCP_EVENTS_LIMITS.maxBodyBytes).toBe(256 * 1024);
  });
});
