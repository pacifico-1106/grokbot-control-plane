import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SLACK_BOT_INSTALL_COOKIE,
  SLACK_BOT_SCOPES,
  signSlackBotInstallState,
  slackBotInstallAuthorizeUrl,
  slackBotInstallRedirectUrl,
  verifySlackBotInstallState,
} from "./oauth";

const TEST_ORG_ID = "org_test_123";
const TEST_NONCE = "test-nonce-abc123";
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

describe("signSlackBotInstallState", () => {
  test("creates signed state with purpose=bot_install", () => {
    const state = signSlackBotInstallState({ orgId: TEST_ORG_ID, nonce: TEST_NONCE });
    expect(state).toContain(".");
    const [encoded] = state.split(".");
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    expect(parsed.orgId).toBe(TEST_ORG_ID);
    expect(parsed.nonce).toBe(TEST_NONCE);
    expect(parsed.purpose).toBe("bot_install");
    expect(parsed.exp).toBeGreaterThan(Date.now());
  });

  test("throws when signing secret is missing", () => {
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
    expect(() => signSlackBotInstallState({ orgId: TEST_ORG_ID, nonce: TEST_NONCE })).toThrow(
      "slack_oauth_unconfigured"
    );
  });
});

describe("verifySlackBotInstallState", () => {
  test("verifies valid state with matching nonce", () => {
    const state = signSlackBotInstallState({ orgId: TEST_ORG_ID, nonce: TEST_NONCE });
    const verified = verifySlackBotInstallState(state, TEST_NONCE);
    expect(verified).not.toBeNull();
    expect(verified?.orgId).toBe(TEST_ORG_ID);
    expect(verified?.nonce).toBe(TEST_NONCE);
    expect(verified?.purpose).toBe("bot_install");
  });

  test("rejects state with mismatched nonce", () => {
    const state = signSlackBotInstallState({ orgId: TEST_ORG_ID, nonce: TEST_NONCE });
    const verified = verifySlackBotInstallState(state, "wrong-nonce");
    expect(verified).toBeNull();
  });

  test("rejects tampered state", () => {
    const state = signSlackBotInstallState({ orgId: TEST_ORG_ID, nonce: TEST_NONCE });
    const tampered = state.replace(/[a-z]/, "X");
    const verified = verifySlackBotInstallState(tampered, TEST_NONCE);
    expect(verified).toBeNull();
  });

  test("rejects empty inputs", () => {
    expect(verifySlackBotInstallState("", TEST_NONCE)).toBeNull();
    expect(verifySlackBotInstallState("valid.state", "")).toBeNull();
  });

  test("rejects state without purpose=bot_install", async () => {
    const payload = {
      orgId: TEST_ORG_ID,
      nonce: TEST_NONCE,
      purpose: "employee_identity",
      exp: Date.now() + 600_000,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", ENCRYPTION_KEY).update(encoded).digest("base64url");
    const state = `${encoded}.${sig}`;
    const verified = verifySlackBotInstallState(state, TEST_NONCE);
    expect(verified).toBeNull();
  });
});

describe("slackBotInstallAuthorizeUrl", () => {
  test("generates URL with bot scopes (not user_scope)", () => {
    const state = signSlackBotInstallState({ orgId: TEST_ORG_ID, nonce: TEST_NONCE });
    const url = slackBotInstallAuthorizeUrl(state);
    expect(url).toContain("https://slack.com/oauth/v2/authorize");
    expect(url).toContain(`scope=${encodeURIComponent(SLACK_BOT_SCOPES)}`);
    expect(url).not.toContain("user_scope=");
  });

  test("uses bot-install redirect URL", () => {
    const state = signSlackBotInstallState({ orgId: TEST_ORG_ID, nonce: TEST_NONCE });
    const url = slackBotInstallAuthorizeUrl(state);
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("bot-install");
  });
});

describe("slackBotInstallRedirectUrl", () => {
  test("returns explicit URL when set", () => {
    process.env.SLACK_BOT_INSTALL_REDIRECT_URL = "https://example.com/custom/callback";
    const url = slackBotInstallRedirectUrl();
    expect(url).toBe("https://example.com/custom/callback");
    delete process.env.SLACK_BOT_INSTALL_REDIRECT_URL;
  });

  test("defaults to /api/slack/bot-install/callback", () => {
    delete process.env.SLACK_BOT_INSTALL_REDIRECT_URL;
    const url = slackBotInstallRedirectUrl();
    expect(url).toContain("/api/slack/bot-install/callback");
  });
});

describe("SLACK_BOT_SCOPES", () => {
  test("contains required bot scopes", () => {
    expect(SLACK_BOT_SCOPES).toContain("im:write");
    expect(SLACK_BOT_SCOPES).toContain("chat:write");
    expect(SLACK_BOT_SCOPES).toContain("im:history");
    expect(SLACK_BOT_SCOPES).toContain("channels:history");
    expect(SLACK_BOT_SCOPES).toContain("groups:history");
    expect(SLACK_BOT_SCOPES).toContain("app_mentions:read");
  });
});

describe("SLACK_BOT_INSTALL_COOKIE", () => {
  test("is distinct from employee OAuth cookie", () => {
    expect(SLACK_BOT_INSTALL_COOKIE).toBe("staffpass_slack_bot_install");
    expect(SLACK_BOT_INSTALL_COOKIE).not.toBe("staffpass_slack_oauth");
  });
});
