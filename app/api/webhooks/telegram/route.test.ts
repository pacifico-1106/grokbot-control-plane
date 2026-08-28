import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApproval, getApprovalById } from "@/lib/data";
import { DEMO_ORG } from "@/lib/demo-data";
import { sendApprovalToTelegram } from "@/lib/notify/telegram";
import { POST } from "./route";

const originalFetch = globalThis.fetch;
const savedEnv = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chat: process.env.TELEGRAM_APPROVAL_CHAT_ID,
  secret: process.env.TELEGRAM_WEBHOOK_SECRET,
  allowed: process.env.TELEGRAM_ALLOWED_USER_IDS,
};
let nextMessageId = 10_000;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_APPROVAL_CHAT_ID = "-100307";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "307";
  globalThis.fetch = (async () =>
    Response.json({ ok: true, result: { message_id: nextMessageId++ } })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    const envKey =
      key === "token"
        ? "TELEGRAM_BOT_TOKEN"
        : key === "chat"
          ? "TELEGRAM_APPROVAL_CHAT_ID"
          : key === "secret"
            ? "TELEGRAM_WEBHOOK_SECRET"
            : "TELEGRAM_ALLOWED_USER_IDS";
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

function webhook(body: unknown, secret = "test-secret") {
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

async function notifiedApproval(jobId: string) {
  const created = await createApproval({
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    title: `承認依頼 ${jobId}`,
    purpose: "sales.outreach",
    summary: "Telegram webhook test",
    risk: "high",
    tool: "mail.send",
    jobId,
  });
  const sent = await sendApprovalToTelegram(created.approval, null);
  expect(sent.ok).toBe(true);
  return (await getApprovalById(created.approval.id, DEMO_ORG.id))!;
}

describe("Telegram webhook", () => {
  test("rejects a secret mismatch", async () => {
    const response = await webhook({}, "wrong");
    expect(response.status).toBe(401);
  });

  test("ignores a different chat with HTTP 200", async () => {
    const response = await webhook({
      message: { message_id: 1, chat: { id: -999 }, from: { id: 307 } },
    });
    expect(response.status).toBe(200);
  });

  test("handles approve and reject callbacks", async () => {
    for (const [action, expected] of [
      ["a", "approved"],
      ["r", "rejected"],
    ] as const) {
      const approval = await notifiedApproval(`job_${expected}_${Date.now()}`);
      const response = await webhook({
        callback_query: {
          id: `callback_${action}`,
          data: `${action}:${approval.telegramRef}`,
          from: { id: 307, username: "owner" },
          message: {
            message_id: approval.telegramMessageId,
            chat: { id: -100307 },
          },
        },
      });
      expect(response.status).toBe(200);
      expect((await getApprovalById(approval.id, DEMO_ORG.id))?.status).toBe(
        expected
      );
    }
  });

  test("turns a revision reply into revision_requested and supports resubmission", async () => {
    const approval = await notifiedApproval(`job_revision_${Date.now()}`);
    await webhook({
      callback_query: {
        id: "callback_edit",
        data: `e:${approval.telegramRef}`,
        from: { id: 307 },
        message: {
          message_id: approval.telegramMessageId,
          chat: { id: -100307 },
        },
      },
    });
    const reply = await webhook({
      message: {
        message_id: 12345,
        text: "2段落目の金額表記を削除してください",
        from: { id: 307 },
        chat: { id: -100307 },
        reply_to_message: { message_id: approval.telegramMessageId },
      },
    });
    expect(reply.status).toBe(200);
    const revised = (await getApprovalById(approval.id, DEMO_ORG.id))!;
    expect(revised.status).toBe("revision_requested");
    expect(revised.revisionNote).toBe("2段落目の金額表記を削除してください");
    expect(revised.revisionCount).toBe(1);

    const child = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: revised.employeeId,
      credentialId: revised.credentialId,
      title: "修正版の再提出",
      purpose: revised.purpose,
      summary: "corrected",
      risk: revised.risk,
      tool: revised.tool,
      jobId: revised.jobId,
      parentApprovalId: revised.id,
    });
    expect(child.approval.parentApprovalId).toBe(revised.id);
    expect(child.approval.revisionCount).toBe(1);
  });

  test("approves when telegramRef matches even if message_id differs", async () => {
    const approval = await notifiedApproval(`job_msgid_${Date.now()}`);
    const response = await webhook({
      callback_query: {
        id: "callback_mismatch",
        data: `a:${approval.telegramRef}`,
        from: { id: 307, username: "owner" },
        message: {
          message_id: Number(approval.telegramMessageId) + 99,
          chat: { id: -100307 },
        },
      },
    });
    expect(response.status).toBe(200);
    expect((await getApprovalById(approval.id, DEMO_ORG.id))?.status).toBe("approved");
  });

  test("approves fallback-org callback even when chat id mismatches", async () => {
    const approval = await notifiedApproval(`job_chat_${Date.now()}`);
    const response = await webhook({
      callback_query: {
        id: "callback_chat",
        data: `a:${approval.telegramRef}`,
        from: { id: 307, username: "owner" },
        message: {
          message_id: approval.telegramMessageId,
          chat: { id: -999 },
        },
      },
    });
    expect(response.status).toBe(200);
    expect((await getApprovalById(approval.id, DEMO_ORG.id))?.status).toBe("approved");
  });
});
