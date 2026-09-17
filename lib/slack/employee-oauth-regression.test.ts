import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SLACK_OAUTH_COOKIE,
  SLACK_USER_SCOPES,
  signSlackOAuthState,
  slackAuthorizeUrl,
  slackOAuthRedirectUrl,
  verifySlackOAuthState,
} from "./oauth";

const TEST_ORG_ID = "org_test_regression";
const TEST_EMPLOYEE_ID = "emp_test_regression";
const TEST_NONCE = "regression-nonce-123";
const ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
const originalKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
const originalSecret = process.env.SLACK_CLIENT_SECRET;
const originalClientId = process.env.SLACK_CLIENT_ID;

beforeEach(() => {
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.SLACK_CLIENT_SECRET = ENCRYPTION_KEY;
  process.env.SLACK_CLIENT_ID = "test-client-id";
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = originalKey;
  if (originalSecret === undefined) delete process.env.SLACK_CLIENT_SECRET;
  else process.env.SLACK_CLIENT_SECRET = originalSecret;
  if (originalClientId === undefined) delete process.env.SLACK_CLIENT_ID;
  else process.env.SLACK_CLIENT_ID = originalClientId;
});

describe("Employee OAuth regression - signSlackOAuthState", () => {
  test("creates signed state with orgId and employeeId (no purpose field)", () => {
    const state = signSlackOAuthState({
      orgId: TEST_ORG_ID,
      employeeId: TEST_EMPLOYEE_ID,
      nonce: TEST_NONCE,
    });
    expect(state).toContain(".");
    const [encoded] = state.split(".");
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    expect(parsed.orgId).toBe(TEST_ORG_ID);
    expect(parsed.employeeId).toBe(TEST_EMPLOYEE_ID);
    expect(parsed.nonce).toBe(TEST_NONCE);
    expect(parsed.exp).toBeGreaterThan(Date.now());
    expect(parsed.purpose).toBeUndefined();
  });
});

describe("Employee OAuth regression - verifySlackOAuthState", () => {
  test("verifies valid state with matching nonce", () => {
    const state = signSlackOAuthState({
      orgId: TEST_ORG_ID,
      employeeId: TEST_EMPLOYEE_ID,
      nonce: TEST_NONCE,
    });
    const verified = verifySlackOAuthState(state, TEST_NONCE);
    expect(verified).not.toBeNull();
    expect(verified?.orgId).toBe(TEST_ORG_ID);
    expect(verified?.employeeId).toBe(TEST_EMPLOYEE_ID);
    expect(verified?.nonce).toBe(TEST_NONCE);
  });

  test("rejects state with mismatched nonce", () => {
    const state = signSlackOAuthState({
      orgId: TEST_ORG_ID,
      employeeId: TEST_EMPLOYEE_ID,
      nonce: TEST_NONCE,
    });
    const verified = verifySlackOAuthState(state, "wrong-nonce");
    expect(verified).toBeNull();
  });

  test("rejects tampered state", () => {
    const state = signSlackOAuthState({
      orgId: TEST_ORG_ID,
      employeeId: TEST_EMPLOYEE_ID,
      nonce: TEST_NONCE,
    });
    const tampered = state.replace(/[a-z]/, "Z");
    const verified = verifySlackOAuthState(tampered, TEST_NONCE);
    expect(verified).toBeNull();
  });
});

describe("Employee OAuth regression - slackAuthorizeUrl", () => {
  test("generates URL with user_scope (not bot scope)", () => {
    const state = signSlackOAuthState({
      orgId: TEST_ORG_ID,
      employeeId: TEST_EMPLOYEE_ID,
      nonce: TEST_NONCE,
    });
    const url = slackAuthorizeUrl(state);
    expect(url).toContain("https://slack.com/oauth/v2/authorize");
    expect(url).toContain(`user_scope=${encodeURIComponent(SLACK_USER_SCOPES)}`);
    expect(url).not.toContain("scope=im%3Awrite");
  });

  test("uses employee OAuth redirect URL (not bot-install)", () => {
    const state = signSlackOAuthState({
      orgId: TEST_ORG_ID,
      employeeId: TEST_EMPLOYEE_ID,
      nonce: TEST_NONCE,
    });
    const url = slackAuthorizeUrl(state);
    expect(url).toContain("redirect_uri=");
    expect(url).not.toContain("bot-install");
  });
});

describe("Employee OAuth regression - slackOAuthRedirectUrl", () => {
  test("returns /api/slack/oauth/callback (not bot-install)", () => {
    delete process.env.SLACK_OAUTH_REDIRECT_URL;
    const url = slackOAuthRedirectUrl();
    expect(url).toContain("/api/slack/oauth/callback");
    expect(url).not.toContain("bot-install");
  });
});

describe("Employee OAuth regression - SLACK_OAUTH_COOKIE", () => {
  test("is distinct from bot-install cookie", () => {
    expect(SLACK_OAUTH_COOKIE).toBe("staffpass_slack_oauth");
    expect(SLACK_OAUTH_COOKIE).not.toBe("staffpass_slack_bot_install");
  });
});

describe("Employee OAuth regression - SLACK_USER_SCOPES", () => {
  test("contains user-specific scopes", () => {
    expect(SLACK_USER_SCOPES).toContain("chat:write");
    expect(SLACK_USER_SCOPES).toContain("users:read");
    expect(SLACK_USER_SCOPES).toContain("channels:read");
    expect(SLACK_USER_SCOPES).toContain("groups:read");
    expect(SLACK_USER_SCOPES).toContain("im:history");
    expect(SLACK_USER_SCOPES).toContain("files:write");
  });

  test("does not contain bot-only scopes", () => {
    expect(SLACK_USER_SCOPES).not.toContain("app_mentions:read");
    expect(SLACK_USER_SCOPES).not.toContain("im:write");
  });
});
