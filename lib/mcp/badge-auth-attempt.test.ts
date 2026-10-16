import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));

const {
  BADGE_AUTH_NEXT_STEP_JA,
  looksLikeBadgeAuthAttempt,
  shouldAdvertiseOAuthChallenge,
} = await import("./badge-auth-attempt");

const ENV = ["MCP_OAUTH_ENABLED", "MCP_EMPLOYEE_BADGE_MCP_ENABLED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const req = (headers: Record<string, string> = {}) =>
  new Request("https://staffpass.test/api/mcp", { headers });

test("looksLikeBadgeAuthAttempt: missing Authorization is not a badge attempt", () => {
  expect(looksLikeBadgeAuthAttempt(req())).toBe(false);
});

test("looksLikeBadgeAuthAttempt: empty / bare / unexpanded Bearer is a badge attempt", () => {
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Bearer" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Bearer " }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Bearer ${env:STAFFPASS_MCP_TOKEN}" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Bearer gb_emp_placeholder" }))).toBe(true);
});

test("looksLikeBadgeAuthAttempt: x-staffpass-credential (even empty) is a badge attempt", () => {
  expect(looksLikeBadgeAuthAttempt(req({ "x-staffpass-credential": "" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ "x-staffpass-credential": "gb_emp_placeholder" }))).toBe(true);
});

test("looksLikeBadgeAuthAttempt: sp_at_ Bearer is an OAuth attempt, not a badge attempt", () => {
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Bearer sp_at_placeholder" }))).toBe(false);
});

test("shouldAdvertiseOAuthChallenge: flag OFF keeps today's OAuth-ON challenge", () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  expect(shouldAdvertiseOAuthChallenge(req())).toBe(true);
  expect(shouldAdvertiseOAuthChallenge(req({ authorization: "Bearer " }))).toBe(true);
  expect(shouldAdvertiseOAuthChallenge(req({ authorization: "Bearer ${env:STAFFPASS_MCP_TOKEN}" }))).toBe(true);
});

test("shouldAdvertiseOAuthChallenge: both flags ON suppresses challenge for badge attempts only", () => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  expect(shouldAdvertiseOAuthChallenge(req())).toBe(true);
  expect(shouldAdvertiseOAuthChallenge(req({ authorization: "Bearer " }))).toBe(false);
  expect(shouldAdvertiseOAuthChallenge(req({ authorization: "Bearer ${env:STAFFPASS_MCP_TOKEN}" }))).toBe(false);
  expect(shouldAdvertiseOAuthChallenge(req({ "x-staffpass-credential": "gb_emp_placeholder" }))).toBe(false);
  expect(shouldAdvertiseOAuthChallenge(req({ authorization: "Bearer sp_at_placeholder" }))).toBe(true);
});

test("shouldAdvertiseOAuthChallenge: OAuth OFF never advertises", () => {
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  expect(shouldAdvertiseOAuthChallenge(req())).toBe(false);
  expect(shouldAdvertiseOAuthChallenge(req({ authorization: "Bearer " }))).toBe(false);
});

test("BADGE_AUTH_NEXT_STEP_JA is one Japanese string and does not mention existence / expiry", () => {
  expect(BADGE_AUTH_NEXT_STEP_JA).toContain("社員証");
  expect(BADGE_AUTH_NEXT_STEP_JA).toContain("静的");
  expect(BADGE_AUTH_NEXT_STEP_JA).toContain("${env:");
  expect(BADGE_AUTH_NEXT_STEP_JA).not.toMatch(/存在|期限切れ|expired|revoked|not found/i);
  expect(BADGE_AUTH_NEXT_STEP_JA).not.toMatch(/gb_emp_[0-9a-f]{8}/i);
});
