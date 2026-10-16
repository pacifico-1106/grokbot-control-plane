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

test("looksLikeBadgeAuthAttempt: header name / Bearer scheme case and surrounding whitespace still count", () => {
  expect(looksLikeBadgeAuthAttempt(req({ Authorization: "bearer" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ AUTHORIZATION: "  Bearer  " }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "\tBearer\t${env:STAFFPASS_MCP_TOKEN}\t" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Bearer   gb_emp_placeholder" }))).toBe(true);
});

test("looksLikeBadgeAuthAttempt: Basic is badge-shaped (not an OAuth client)", () => {
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Basic dXNlcjpwYXNz" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "basic YWRtaW46" }))).toBe(true);
});

test("looksLikeBadgeAuthAttempt: multiple Authorization — empty Bearer next to sp_at_ is still a badge attempt", () => {
  const firstOauth = new Headers();
  firstOauth.append("authorization", "Bearer sp_at_placeholder");
  firstOauth.append("authorization", "Bearer");
  expect(looksLikeBadgeAuthAttempt(new Request("https://staffpass.test/api/mcp", { headers: firstOauth }))).toBe(true);

  const firstEmpty = new Headers();
  firstEmpty.append("authorization", "Bearer");
  firstEmpty.append("authorization", "Bearer sp_at_placeholder");
  expect(looksLikeBadgeAuthAttempt(new Request("https://staffpass.test/api/mcp", { headers: firstEmpty }))).toBe(true);

  const firstUnexpanded = new Headers();
  firstUnexpanded.append("authorization", "Bearer ${env:STAFFPASS_MCP_TOKEN}");
  firstUnexpanded.append("authorization", "Bearer sp_at_placeholder");
  expect(looksLikeBadgeAuthAttempt(new Request("https://staffpass.test/api/mcp", { headers: firstUnexpanded }))).toBe(true);
});

test("looksLikeBadgeAuthAttempt: x-staffpass-credential + Authorization (including sp_at_) is a badge attempt", () => {
  expect(looksLikeBadgeAuthAttempt(req({ "x-staffpass-credential": "", authorization: "Bearer sp_at_placeholder" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ "x-staffpass-credential": "   ", authorization: "Bearer sp_at_placeholder" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ "x-staffpass-credential": "gb_emp_placeholder", authorization: "Bearer sp_at_placeholder" }))).toBe(true);
});

test("looksLikeBadgeAuthAttempt: sp_at_ in x-staffpass-credential is a badge attempt (never OAuth)", () => {
  expect(looksLikeBadgeAuthAttempt(req({ "x-staffpass-credential": "sp_at_placeholder" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ "X-Staffpass-Credential": "sp_at_placeholder" }))).toBe(true);
});

test("looksLikeBadgeAuthAttempt: mixed-case / padded sp_at_ prefix is not treated as a live OAuth token", () => {
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Bearer SP_AT_placeholder" }))).toBe(true);
  expect(looksLikeBadgeAuthAttempt(req({ authorization: "Bearer  sp_at_placeholder" }))).toBe(false);
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
  expect(shouldAdvertiseOAuthChallenge(req({ authorization: "Basic dXNlcjpwYXNz" }))).toBe(false);
  expect(shouldAdvertiseOAuthChallenge(req({ authorization: "bearer" }))).toBe(false);
  expect(shouldAdvertiseOAuthChallenge(req({ "x-staffpass-credential": "", authorization: "Bearer sp_at_placeholder" }))).toBe(false);
  const mixed = new Headers();
  mixed.append("authorization", "Bearer sp_at_placeholder");
  mixed.append("authorization", "Bearer");
  expect(shouldAdvertiseOAuthChallenge(new Request("https://staffpass.test/api/mcp", { headers: mixed }))).toBe(false);
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
