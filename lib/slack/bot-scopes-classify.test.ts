/**
 * 木村 10/10: channel-classify proposals need the bot token to read channel /
 * user info. The bot install (/app/slack-bot-install) must request
 * channels:read, groups:read, users:read, im:read, mpim:read — a reinstall
 * otherwise never picks the new scopes up. Existing bot scopes and the
 * employee user scopes stay unchanged. Dummy client id / secrets only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SLACK_BOT_SCOPES,
  SLACK_USER_SCOPES,
  signSlackBotInstallState,
  slackAuthorizeUrl,
  slackBotInstallAuthorizeUrl,
  slackUserScopesForAuthorize,
} from "./oauth";

const NEW_BOT_SCOPES = ["channels:read", "groups:read", "users:read", "im:read", "mpim:read"];
const EXISTING_BOT_SCOPES = ["im:write", "app_mentions:read", "channels:history", "groups:history", "im:history", "chat:write", "files:write"];
const USER_SCOPES_BEFORE =
  "chat:write,users:read,channels:read,groups:read,im:history,files:write,channels:history,groups:history";
const KEY = "test-key-that-is-at-least-32-characters-long";
const ENV = ["NOTIFICATION_CONFIG_ENCRYPTION_KEY", "SLACK_CLIENT_SECRET", "SLACK_CLIENT_ID", "SLACK_USER_SCOPE_IM_WRITE"];
let backup: Record<string, string | undefined> = {};

beforeEach(() => {
  backup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = KEY;
  process.env.SLACK_CLIENT_SECRET = KEY;
  process.env.SLACK_CLIENT_ID = "test-client-id";
  delete process.env.SLACK_USER_SCOPE_IM_WRITE;
});
afterEach(() => {
  for (const k of ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

function installScopes(): string[] {
  const state = signSlackBotInstallState({ orgId: "org_scope_test", nonce: "nonce-scope-test" });
  const url = new URL(slackBotInstallAuthorizeUrl(state));
  expect(url.searchParams.get("user_scope")).toBeNull();
  return (url.searchParams.get("scope") || "").split(",");
}

describe("bot install requests the channel-classify read scopes", () => {
  for (const scope of NEW_BOT_SCOPES) {
    test(`install URL scope= contains ${scope}`, () => {
      expect(installScopes()).toContain(scope);
    });
  }

  test("existing bot scopes are kept", () => {
    const scopes = installScopes();
    for (const s of EXISTING_BOT_SCOPES) expect(scopes).toContain(s);
  });

  test("exactly the existing + new scopes, no duplicates", () => {
    const scopes = installScopes();
    expect(new Set(scopes).size).toBe(scopes.length);
    expect([...scopes].sort()).toEqual([...EXISTING_BOT_SCOPES, ...NEW_BOT_SCOPES].sort());
    expect(SLACK_BOT_SCOPES.split(",").sort()).toEqual([...scopes].sort());
  });
});

describe("employee user scopes are unchanged", () => {
  test("SLACK_USER_SCOPES string is byte-identical", () => {
    expect(SLACK_USER_SCOPES).toBe(USER_SCOPES_BEFORE);
    expect(slackUserScopesForAuthorize()).toBe(USER_SCOPES_BEFORE);
  });

  test("employee authorize URL: user_scope unchanged, no bot scope= added", () => {
    const url = new URL(slackAuthorizeUrl("state-x"));
    expect(url.searchParams.get("user_scope")).toBe(USER_SCOPES_BEFORE);
    expect(url.searchParams.get("scope")).toBeNull();
  });
});
