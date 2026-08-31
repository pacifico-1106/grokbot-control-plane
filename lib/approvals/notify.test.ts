import { afterEach, describe, expect, test } from "bun:test";
import { resendPendingApprovalNotifications } from "@/lib/approvals/notify";
import {
  createApproval,
  getApprovalById,
  resolveApproval,
} from "@/lib/data";
import {
  resetDemoNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { DEMO_ORG } from "@/lib/demo-data";
import { channelErrorMessage } from "@/lib/notify/channel-errors";

const originalFetch = globalThis.fetch;
const originalEnv = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chat: process.env.TELEGRAM_APPROVAL_CHAT_ID,
  secret: process.env.TELEGRAM_WEBHOOK_SECRET,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDemoNotificationChannels(DEMO_ORG.id);
  if (originalEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalEnv.token;
  if (originalEnv.chat === undefined) delete process.env.TELEGRAM_APPROVAL_CHAT_ID;
  else process.env.TELEGRAM_APPROVAL_CHAT_ID = originalEnv.chat;
  if (originalEnv.secret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = originalEnv.secret;
});

async function pendingTicket() {
  const created = await createApproval({
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    title: "承認依頼: sns.publish",
    purpose: "sns.publish",
    summary: "notify retry test",
    risk: "high",
    tool: "sns.publish",
    jobId: `job_notify_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  });
  return created.approval;
}

describe("resendPendingApprovalNotifications", () => {
  test("pending same-org re-sends the card without changing status", async () => {
    const inbox = await upsertNotificationChannel({
      orgId: DEMO_ORG.id,
      provider: "telegram",
      enabled: true,
      label: "再送テスト",
      config: { chatId: "8446547736" },
      secrets: { botToken: "tok-retry-secret", webhookSecret: "sec-retry" },
    });
    const approval = await pendingTicket();
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push(String(input));
      const payload = JSON.parse(String(init?.body || "{}")) as { chat_id?: string };
      expect(payload.chat_id).toBe("8446547736");
      return Response.json({ ok: true, result: { message_id: 99 } });
    }) as typeof fetch;

    const result = await resendPendingApprovalNotifications(approval.id, DEMO_ORG.id);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    const results = result.body.results as Array<{ ok: boolean; provider: string; channelId?: string }>;
    expect(results).toEqual([
      { ok: true, provider: "telegram", channelId: inbox.id },
    ]);
    expect(JSON.stringify(result.body)).not.toContain("tok-retry-secret");
    expect(JSON.stringify(result.body)).not.toContain("sec-retry");
    expect(JSON.stringify(result.body)).not.toContain(approval.pollPath);
    expect(JSON.stringify(result.body)).not.toContain(approval.statusToken);
    expect(calls.some((url) => url.includes("/sendMessage"))).toBe(true);
    expect(calls.some((url) => url.includes("gateway"))).toBe(false);

    const again = await getApprovalById(approval.id, DEMO_ORG.id);
    expect(again?.status).toBe("pending");
    expect(again?.resolvedAt).toBeNull();
  });

  test("approved ticket is not re-sent and stays approved", async () => {
    const approval = await pendingTicket();
    const resolved = await resolveApproval(
      approval.id,
      "approved",
      "tester@example.com",
      DEMO_ORG.id
    );
    expect(resolved?.status).toBe("approved");

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;

    const result = await resendPendingApprovalNotifications(approval.id, DEMO_ORG.id);
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("approval_not_pending");
    expect(
      channelErrorMessage(result.body, "再送に失敗しました")
    ).toBe("承認待ちの依頼だけ再送できます");
    expect(fetchCalled).toBe(false);
    expect((await getApprovalById(approval.id, DEMO_ORG.id))?.status).toBe("approved");
  });

  test("wrong org cannot load the ticket", async () => {
    const approval = await pendingTicket();
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;

    const result = await resendPendingApprovalNotifications(approval.id, "org_other");
    expect(result.status).toBe(404);
    expect(result.body.error).toBe("approval_not_found");
    expect(
      channelErrorMessage(result.body, "再送に失敗しました")
    ).toBe("承認依頼が見つかりません");
    expect(fetchCalled).toBe(false);
    expect((await getApprovalById(approval.id, DEMO_ORG.id))?.status).toBe("pending");
  });

  test("telegram delivery failure still leaves the ticket pending", async () => {
    await upsertNotificationChannel({
      orgId: DEMO_ORG.id,
      provider: "telegram",
      enabled: true,
      config: { chatId: "8446547736" },
      secrets: { botToken: "tok-retry-secret", webhookSecret: "sec-retry" },
    });
    const approval = await pendingTicket();
    globalThis.fetch = (async () =>
      Response.json({
        ok: false,
        description: "Forbidden: bot can't initiate conversation with a user",
      })) as typeof fetch;

    const result = await resendPendingApprovalNotifications(approval.id, DEMO_ORG.id);
    expect(result.status).toBe(200);
    const results = result.body.results as Array<{ ok: boolean; error?: string }>;
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("Forbidden");
    expect(channelErrorMessage(results[0], "再送に失敗しました")).toContain("/start");
    expect(JSON.stringify(result.body)).not.toContain("tok-retry-secret");
    expect((await getApprovalById(approval.id, DEMO_ORG.id))?.status).toBe("pending");
  });
});
