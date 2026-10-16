import { afterEach, describe, expect, test } from "bun:test";
import { isCommAccountsEnabled, isLineConversationEnabled, isLineWebhookAutoSetupEnabled } from "@/lib/comm/flags";

const KEYS = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "LINE_WEBHOOK_AUTO_SETUP_ENABLED"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("LINE PoC flags (default OFF)", () => {
  test("unset → OFF", () => {
    for (const k of KEYS) delete process.env[k];
    expect(isCommAccountsEnabled()).toBe(false);
    expect(isLineConversationEnabled()).toBe(false);
    expect(isLineWebhookAutoSetupEnabled()).toBe(false);
  });
  test("only explicit truthy values turn them ON", () => {
    for (const v of ["", "0", "false", "off", "no", "yes please"]) {
      process.env.COMM_ACCOUNTS_ENABLED = v;
      process.env.LINE_CONVERSATION_ENABLED = v;
      process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED = v;
      expect(isCommAccountsEnabled()).toBe(false);
      expect(isLineConversationEnabled()).toBe(false);
      expect(isLineWebhookAutoSetupEnabled()).toBe(false);
    }
    for (const v of ["true", "1", "on", "TRUE"]) {
      process.env.COMM_ACCOUNTS_ENABLED = v;
      expect(isCommAccountsEnabled()).toBe(true);
    }
  });
  test("LINE conversation needs the accounts flag too", () => {
    process.env.LINE_CONVERSATION_ENABLED = "true";
    delete process.env.COMM_ACCOUNTS_ENABLED;
    expect(isLineConversationEnabled()).toBe(false);
    process.env.COMM_ACCOUNTS_ENABLED = "true";
    expect(isLineConversationEnabled()).toBe(true);
    expect(isLineWebhookAutoSetupEnabled()).toBe(false);
  });
  test("webhook auto-setup needs conversation + its own flag", () => {
    process.env.COMM_ACCOUNTS_ENABLED = "true";
    process.env.LINE_CONVERSATION_ENABLED = "true";
    delete process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED;
    expect(isLineWebhookAutoSetupEnabled()).toBe(false);
    process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED = "true";
    expect(isLineWebhookAutoSetupEnabled()).toBe(true);
    process.env.LINE_CONVERSATION_ENABLED = "";
    expect(isLineWebhookAutoSetupEnabled()).toBe(false);
  });
});
