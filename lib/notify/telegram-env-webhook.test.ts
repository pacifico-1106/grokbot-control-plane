import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST } from "@/app/api/webhooks/telegram/route";
import { createApproval, getApprovalById } from "@/lib/data/approvals";
import {
  getNotificationChannelByWebhookRef,
  listNotificationChannels,
  resetDemoNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { DEMO_ORG } from "@/lib/demo-data";
import { sendApprovalToTelegramChannel } from "@/lib/notify/telegram";

const originalFetch = globalThis.fetch;
const savedEnv = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chat: process.env.TELEGRAM_APPROVAL_CHAT_ID,
  secret: process.env.TELEGRAM_WEBHOOK_SECRET,
  allowed: process.env.TELEGRAM_ALLOWED_USER_IDS,
};

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "env-bot-token-test";
  process.env.TELEGRAM_APPROVAL_CHAT_ID = "-100307";
  process.env.TELEGRAM_WEBHOOK_SECRET = "env-hook-secret-test";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "307";
  globalThis.fetch = (async () =>
    Response.json({ ok: true, result: { message_id: 42_001 } })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDemoNotificationChannels(DEMO_ORG.id);
  if (savedEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedEnv.token;
  if (savedEnv.chat === undefined) delete process.env.TELEGRAM_APPROVAL_CHAT_ID;
  else process.env.TELEGRAM_APPROVAL_CHAT_ID = savedEnv.chat;
  if (savedEnv.secret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = savedEnv.secret;
  if (savedEnv.allowed === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  else process.env.TELEGRAM_ALLOWED_USER_IDS = savedEnv.allowed;
});

function webhook(body: unknown, secret = "env-hook-secret-test") {
  return POST(
    new Request("http://localhost/api/webhooks/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(body),
    })
  );
}

describe("global telegram webhook routes by chatId", () => {
  test("approves a tenant inbox callback that is not the env chat", async () => {
    const first = await upsertNotificationChannel({
      orgId: DEMO_ORG.id,
      provider: "telegram",
      enabled: true,
      label: "安藤グループ",
      config: { chatId: "" },
      secrets: {},
    });
    const second = await upsertNotificationChannel({
      orgId: DEMO_ORG.id,
      provider: "telegram",
      enabled: true,
      isDefault: false,
      label: "依頼者DM",
      config: { chatId: "555666" },
      secrets: {},
    });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const created = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "承認依頼 DM",
      purpose: "sales.outreach",
      summary: "tenant inbox webhook",
      risk: "high",
      tool: "mail.send",
      jobId: `job_dm_${Date.now()}`,
    });
    const runtime = await getNotificationChannelByWebhookRef("telegram", second.webhookRef);
    expect(runtime).toBeTruthy();
    const sent = await sendApprovalToTelegramChannel(created.approval, null, runtime!);
    expect(sent.ok).toBe(true);

    const response = await webhook({
      callback_query: {
        id: "cb_dm",
        data: `a:${created.approval.telegramRef}`,
        from: { id: 999 },
        message: { message_id: sent.messageId, chat: { id: 555666 } },
      },
    });
    expect(response.status).toBe(200);
    expect((await getApprovalById(created.approval.id, DEMO_ORG.id))?.status).toBe("approved");
  });

  test("keeps env-chat callbacks working after a second inbox exists", async () => {
    await upsertNotificationChannel({
      orgId: DEMO_ORG.id,
      provider: "telegram",
      enabled: true,
      label: "安藤グループ",
      config: { chatId: "" },
      secrets: {},
    });
    await upsertNotificationChannel({
      orgId: DEMO_ORG.id,
      provider: "telegram",
      enabled: true,
      isDefault: false,
      label: "依頼者DM",
      config: { chatId: "555666" },
      secrets: {},
    });
    const created = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "承認依頼 グループ",
      purpose: "sales.outreach",
      summary: "default inbox webhook",
      risk: "high",
      tool: "mail.send",
      jobId: `job_group_${Date.now()}`,
    });
    const def = (await listNotificationChannels(DEMO_ORG.id)).find((row) => row.isDefault);
    const listed = await getNotificationChannelByWebhookRef("telegram", def!.webhookRef);
    const sent = await sendApprovalToTelegramChannel(created.approval, null, listed!);
    expect(sent.ok).toBe(true);
    const response = await webhook({
      callback_query: {
        id: "cb_group",
        data: `a:${created.approval.telegramRef}`,
        from: { id: 307 },
        message: { message_id: sent.messageId, chat: { id: -100307 } },
      },
    });
    expect(response.status).toBe(200);
    expect((await getApprovalById(created.approval.id, DEMO_ORG.id))?.status).toBe("approved");
  });
});
