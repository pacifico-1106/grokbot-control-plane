import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAppOrigin } from "../approvals/tokens";
import { DEMO_ORG } from "../demo-data";
import { resetDemoNotificationChannels } from "../data/notification-channels";
import {
  buildApprovalTelegramMessage,
  ensureGlobalTelegramWebhook,
  registerTelegramWebhook,
  sendApprovalToTelegram,
} from "./telegram";
import type { NotificationChannelRuntime } from "../data/notification-channels";
import type { ApprovalRequest } from "../types";

const approval: ApprovalRequest = {
  id: "apr_test_telegram",
  orgId: "org_demo",
  employeeId: "emp_sales",
  credentialId: "cred_sales",
  title: "承認依頼: mail.send",
  purpose: "sales.outreach",
  summary: `<顧客> & ${"長".repeat(450)}`,
  risk: "high",
  status: "pending",
  tool: "mail.send",
  jobId: "job_telegram_test",
  revisionNote: null,
  revisionCount: 0,
  parentApprovalId: null,
  telegramRef: "a1b2c3d4e5f6",
  telegramMessageId: null,
  metadata: { artifact_url: "https://example.com/artifact" },
  statusToken: "st_test",
  pollPath: "/api/approvals/status?id=x&token=y",
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedBy: null,
};

const originalFetch = globalThis.fetch;
const originalEnv = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chat: process.env.TELEGRAM_APPROVAL_CHAT_ID,
  secret: process.env.TELEGRAM_WEBHOOK_SECRET,
  origin: process.env.NEXT_PUBLIC_APP_URL,
};

beforeEach(() => {
  resetDemoNotificationChannels(DEMO_ORG.id);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDemoNotificationChannels(DEMO_ORG.id);
  if (originalEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalEnv.token;
  if (originalEnv.chat === undefined) delete process.env.TELEGRAM_APPROVAL_CHAT_ID;
  else process.env.TELEGRAM_APPROVAL_CHAT_ID = originalEnv.chat;
  if (originalEnv.secret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = originalEnv.secret;
  if (originalEnv.origin === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalEnv.origin;
});

describe("Telegram approval notification", () => {
  test("escapes HTML, keeps a short full summary, and includes the artifact", () => {
    const text = buildApprovalTelegramMessage(approval, null);
    expect(text).toContain("&lt;顧客&gt; &amp;");
    expect(text).toContain('href="https://example.com/artifact"');
    expect(text).toContain("長".repeat(450));
    expect(text).not.toContain("続きはダッシュボード");
    expect(text.length).toBeLessThan(1_200);
  });

  test("trims Telegram overflow with a dashboard pointer while DB summary stays full", () => {
    const huge = { ...approval, summary: `本文\n${"あ".repeat(5000)}` };
    const text = buildApprovalTelegramMessage(huge, null);
    expect(Array.from(text).length).toBeLessThanOrEqual(4096);
    expect(text).toContain("…(続きはダッシュボード)");
    expect(huge.summary.length > 4096).toBe(true);
  });

  test("skips without Telegram env", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_APPROVAL_CHAT_ID;
    expect(await sendApprovalToTelegram(approval, null)).toEqual({
      ok: false,
      skipped: true,
    });
  });

  test("keeps every callback_data below Telegram's 64-byte limit", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_APPROVAL_CHAT_ID = "-100123";
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      payload = JSON.parse(String(init?.body || "{}"));
      return Response.json({ ok: true, result: { message_id: 123 } });
    }) as typeof fetch;

    await sendApprovalToTelegram(approval, null);
    const keyboard = payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    for (const button of keyboard.inline_keyboard.flat()) {
      expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  test("skips global webhook registration when token or secret is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect(await ensureGlobalTelegramWebhook()).toEqual({ ok: false, skipped: true });
  });

  test("sendApprovalToTelegram registers the global webhook before sendMessage", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_APPROVAL_CHAT_ID = "-100123";
    process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://staffpass.example";
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = url.split("/").pop() || "";
      calls.push({ method, body: JSON.parse(String(init?.body || "{}")) });
      return Response.json({ ok: true, result: { message_id: 123 } });
    }) as typeof fetch;

    await sendApprovalToTelegram(approval, null);
    const setWebhookIndex = calls.findIndex((call) => call.method === "setWebhook");
    const sendMessageIndex = calls.findIndex((call) => call.method === "sendMessage");
    expect(setWebhookIndex >= 0).toBe(true);
    expect(sendMessageIndex > setWebhookIndex).toBe(true);
    expect(calls[setWebhookIndex].body).toEqual({
      url: `${getAppOrigin()}/api/webhooks/telegram`,
      secret_token: "hook-secret",
      allowed_updates: ["message", "callback_query"],
    });
  });
});

function channelRuntime(token: string, secret: string): NotificationChannelRuntime {
  return {
    id: "chn_env_reuse",
    orgId: DEMO_ORG.id,
    provider: "telegram",
    label: "env",
    enabled: true,
    isDefault: true,
    config: { chatId: "-100307" },
    webhookRef: "refenv1",
    hasCredentials: true,
    webhookPath: "/api/webhooks/telegram/refenv1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    secrets: { botToken: token, webhookSecret: secret },
  };
}

describe("registerTelegramWebhook env reuse", () => {
  test("skips setWebhook when the channel token is the env bot", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-bot-token-test";
    process.env.TELEGRAM_WEBHOOK_SECRET = "env-hook-secret-test";
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return Response.json({ ok: true, result: true });
    }) as typeof fetch;
    const result = await registerTelegramWebhook(
      channelRuntime("env-bot-token-test", "env-hook-secret-test"),
      "https://staffpass.example/api/webhooks/telegram/refenv1"
    );
    expect(result).toEqual({ ok: true, skipped: true });
    expect(calls.some((url) => url.includes("setWebhook"))).toBe(false);
  });

  test("still registers setWebhook for a custom bot token", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-bot-token-test";
    process.env.TELEGRAM_WEBHOOK_SECRET = "env-hook-secret-test";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
      return Response.json({ ok: true, result: true });
    }) as typeof fetch;
    const result = await registerTelegramWebhook(
      channelRuntime("custom-bot-token", "custom-hook-secret"),
      "https://staffpass.example/api/webhooks/telegram/refcustom"
    );
    expect(result).toEqual({ ok: true });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain("/botcustom-bot-token/setWebhook");
    expect(calls[0]?.body.url).toBe("https://staffpass.example/api/webhooks/telegram/refcustom");
  });
});
