import { afterEach, describe, expect, test } from "bun:test";
import {
  SLACK_BOT_SCOPES,
  SLACK_BOT_SCOPES_CHANNEL_SCOPE,
  signSlackBotInstallState,
  slackBotInstallAuthorizeUrl,
  slackBotInstallScopes,
} from "@/lib/slack/oauth";

const saved = { flag: process.env.P1_CHANNEL_SCOPE_ENABLED, key: process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY };
afterEach(() => {
  if (saved.flag === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_ENABLED = saved.flag;
  if (saved.key === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = saved.key;
});

describe("bot install scopes (CS6)", () => {
  test("flag OFF ⇒ exactly the legacy bot scopes", () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    expect(slackBotInstallScopes()).toBe(SLACK_BOT_SCOPES);
  });

  test("flag ON ⇒ adds channels:read, groups:read, users:read (no duplicates, legacy kept)", () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const scopes = slackBotInstallScopes().split(",");
    for (const s of [...SLACK_BOT_SCOPES.split(","), ...SLACK_BOT_SCOPES_CHANNEL_SCOPE.split(",")]) expect(scopes).toContain(s);
    expect(new Set(scopes).size).toBe(scopes.length);
    process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY || "k".repeat(32);
    const url = slackBotInstallAuthorizeUrl(signSlackBotInstallState({ orgId: "org_x", nonce: "n1" }));
    expect(decodeURIComponent(url)).toContain("channels:read,groups:read,users:read");
  });
});
