import { afterEach, describe, expect, test } from "bun:test";
import {
  buildApprovalTelegramMessage,
  sendApprovalToTelegram,
} from "./telegram";
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
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalEnv.token;
  if (originalEnv.chat === undefined) delete process.env.TELEGRAM_APPROVAL_CHAT_ID;
  else process.env.TELEGRAM_APPROVAL_CHAT_ID = originalEnv.chat;
});

describe("Telegram approval notification", () => {
  test("escapes HTML, truncates the summary, and includes the artifact", () => {
    const text = buildApprovalTelegramMessage(approval, null);
    expect(text).toContain("&lt;顧客&gt; &amp;");
    expect(text).toContain('href="https://example.com/artifact"');
    expect(text.length).toBeLessThan(1_200);
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
});
