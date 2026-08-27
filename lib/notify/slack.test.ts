import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { upsertNotificationChannel } from "@/lib/data/notification-channels";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { verifySlackSignature } from "@/lib/notify/slack";
import type { ApprovalRequest } from "@/lib/types";

const secret = "slack-signing-secret-for-tests";

function sign(rawBody: string, timestamp: string, key = secret): string {
  return `v0=${createHmac("sha256", key).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

const approval: ApprovalRequest = {
  id: "apr_test_slack",
  orgId: "org_slack_notify_test",
  employeeId: "emp_comm",
  credentialId: "cred_comm",
  title: "承認依頼: slack.post",
  purpose: "comm.internal",
  summary: "社内連絡の下書き",
  risk: "low",
  status: "pending",
  tool: "slack.post",
  jobId: "job_slack_notify",
  revisionNote: null,
  revisionCount: 0,
  parentApprovalId: null,
  telegramRef: "s1a2c3k4ref5",
  telegramMessageId: null,
  metadata: {},
  statusToken: "st_slack",
  pollPath: "/api/approvals/status?id=x&token=y",
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedBy: null,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("verifySlackSignature", () => {
  test("accepts a matching HMAC over the raw body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "payload=%7B%22type%22%3A%22block_actions%22%7D";
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody,
        signature: sign(rawBody, timestamp),
      })
    ).toBe(true);
  });

  test("rejects a bad signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = '{"ok":true}';
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody,
        signature: sign(rawBody, timestamp, "other-secret"),
      })
    ).toBe(false);
  });

  test("rejects a replay older than five minutes", () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const rawBody = '{"ok":true}';
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        rawBody,
        signature: sign(rawBody, timestamp),
      })
    ).toBe(false);
  });
});

describe("Slack approval notify provider", () => {
  test("dispatches chat.postMessage with Block Kit buttons without throwing", async () => {
    await upsertNotificationChannel({
      orgId: approval.orgId,
      provider: "slack",
      enabled: true,
      label: "承認用Slack",
      config: { channelId: "C_NOTIFY", allowedUserIds: ["U_ADMIN"] },
      secrets: { botToken: "xoxb-test", signingSecret: secret },
    });
    let url = "";
    let payload: Record<string, unknown> = {};
    let auth = "";
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
      payload = JSON.parse(String(init?.body || "{}"));
      return Response.json({ ok: true, channel: "C_NOTIFY", ts: "1503435956.000247" });
    }) as typeof fetch;

    const results = await sendApprovalNotifications(approval, null);
    const slack = results.find((item) => item.provider === "slack");
    expect(slack?.ok).toBe(true);
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(auth).toBe("Bearer xoxb-test");
    expect(payload.channel).toBe("C_NOTIFY");
    expect(payload.text).toContain("承認依頼");
    const blocks = payload.blocks as Array<{ type: string; elements?: Array<{ action_id?: string; style?: string; text?: { type?: string } }> }>;
    const actions = blocks.find((block) => block.type === "actions");
    const ids = (actions?.elements || []).map((el) => el.action_id);
    expect(ids).toContain("staffpass_approve");
    expect(ids).toContain("staffpass_reject");
    expect(ids).toContain("staffpass_revise");
    expect(actions?.elements?.find((el) => el.action_id === "staffpass_approve")?.style).toBe("primary");
    expect(actions?.elements?.find((el) => el.action_id === "staffpass_reject")?.style).toBe("danger");
    expect(actions?.elements?.every((el) => !el.text || el.text.type === "plain_text")).toBe(true);
  });
});
