import { afterEach, describe, expect, test } from "bun:test";
import {
  listNotificationChannels,
  resetDemoNotificationChannels,
  resolveEmployeeApprovalChannel,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import type { ApprovalRequest, Employee } from "@/lib/types";

const ORG = "org_inbox_test";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDemoNotificationChannels(ORG);
});

async function twoTelegramInboxes() {
  const def = await upsertNotificationChannel({
    orgId: ORG,
    provider: "telegram",
    enabled: true,
    label: "安藤の既定",
    config: { chatId: "111" },
    secrets: { botToken: "tok-default", webhookSecret: "sec-a" },
  });
  const employeeInbox = await upsertNotificationChannel({
    orgId: ORG,
    provider: "telegram",
    enabled: true,
    isDefault: false,
    label: "八坂のDM",
    config: { chatId: "222", allowedUserIds: ["yasaka"] },
    secrets: { botToken: "tok-employee", webhookSecret: "sec-b" },
  });
  return { def, employeeInbox };
}

function approval(): ApprovalRequest {
  return {
    id: "apr_inbox_test",
    orgId: ORG,
    employeeId: "emp_inbox",
    credentialId: "cred_inbox",
    title: "承認依頼: mail.send",
    purpose: "sales.outreach",
    summary: "八坂の承認カード",
    risk: "high",
    status: "pending",
    tool: "mail.send",
    jobId: "job_inbox",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: "inboxref12",
    telegramMessageId: null,
    metadata: {},
    statusToken: "st_inbox",
    pollPath: "/api/approvals/status?id=x&token=y",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
}

describe("per-employee approval inboxes", () => {
  test("unique-provider no longer blocks a second telegram row", async () => {
    const { def, employeeInbox } = await twoTelegramInboxes();
    expect(def.id).not.toBe(employeeInbox.id);
    expect(def.isDefault).toBe(true);
    expect(employeeInbox.isDefault).toBe(false);
    expect(def.webhookRef).not.toBe(employeeInbox.webhookRef);
    const listed = await listNotificationChannels(ORG);
    expect(listed.filter((row) => row.provider === "telegram").length).toBe(2);
    expect(listed[0]?.id).toBe(def.id);
  });

  test("unset employee channel falls back to org default", async () => {
    const { def, employeeInbox } = await twoTelegramInboxes();
    const unset = await resolveEmployeeApprovalChannel(ORG, { approvalChannelId: null });
    expect(unset?.id).toBe(def.id);
    const pointed = await resolveEmployeeApprovalChannel(ORG, {
      approvalChannelId: employeeInbox.id,
    });
    expect(pointed?.id).toBe(employeeInbox.id);
    const missing = await resolveEmployeeApprovalChannel(ORG, {
      approvalChannelId: "chn_missing",
    });
    expect(missing?.id).toBe(def.id);
  });

  test("notify uses employee channel chat, not the org default", async () => {
    const { employeeInbox } = await twoTelegramInboxes();
    const chats: string[] = [];
    const tokens: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const href = String(input);
      const payload = JSON.parse(String(init?.body || "{}")) as { chat_id?: string };
      chats.push(String(payload.chat_id || ""));
      tokens.push(href);
      return Response.json({ ok: true, result: { message_id: 42 } });
    }) as typeof fetch;

    const results = await sendApprovalNotifications(approval(), {
      approvalChannelId: employeeInbox.id,
    } as Employee);
    expect(results.length).toBe(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.channelId).toBe(employeeInbox.id);
    expect(chats).toEqual(["222"]);
    expect(tokens.some((url) => url.includes("/bottok-employee/"))).toBe(true);
    expect(tokens.some((url) => url.includes("/bottok-default/"))).toBe(false);
  });

  test("notify without employee channel uses the org default", async () => {
    await twoTelegramInboxes();
    const chats: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as { chat_id?: string };
      chats.push(String(payload.chat_id || ""));
      return Response.json({ ok: true, result: { message_id: 7 } });
    }) as typeof fetch;

    const results = await sendApprovalNotifications(approval(), {
      approvalChannelId: null,
    } as Employee);
    expect(results.length).toBe(1);
    expect(results[0]?.ok).toBe(true);
    expect(chats).toEqual(["111"]);
  });
});
