/**
 * PR-3: a real approval that reaches no inbox raises the fail-closed alert.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApprovalRequest } from "@/lib/types";

let alertOn = true;
const alerts: Array<Record<string, unknown>> = [];
mock.module("@/lib/notify/delivery-failure-alert", () => ({
  isApprovalDeliveryFailureAlertEnabled: () => alertOn,
  alertApprovalDeliveryFailure: async (input: Record<string, unknown>) => {
    alerts.push(input);
    return { status: "sent" };
  },
}));

const { upsertNotificationChannel } = await import("@/lib/data/notification-channels");
const { sendApprovalNotifications } = await import("@/lib/notify/channels");

function approvalFor(orgId: string, id: string): ApprovalRequest {
  return {
    id,
    orgId,
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    title: "承認依頼: slack.post",
    purpose: "comm.internal",
    summary: "社内連絡の下書き",
    risk: "low",
    status: "pending",
    tool: "slack.post",
    jobId: "job_alert",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: `ref${id}`,
    telegramMessageId: null,
    metadata: {},
    statusToken: "st_alert",
    pollPath: "/api/approvals/status?id=x&token=y",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
}

const originalFetch = globalThis.fetch;
let slackReply: Record<string, unknown> = { ok: true, channel: "C_NOTIFY", ts: "1.2" };

beforeEach(async () => {
  alertOn = true;
  alerts.length = 0;
  globalThis.fetch = (async () => Response.json(slackReply)) as unknown as typeof fetch;
  await upsertNotificationChannel({
    orgId: "org_alert_slack",
    provider: "slack",
    enabled: true,
    label: "承認用Slack",
    config: { channelId: "C_NOTIFY", allowedUserIds: ["U_ADMIN"] },
    secrets: { botToken: "xoxb-test", signingSecret: "sig" },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sendApprovalNotifications → delivery failure alert", () => {
  test("delivered: no alert", async () => {
    slackReply = { ok: true, channel: "C_NOTIFY", ts: "1.2" };
    const results = await sendApprovalNotifications(approvalFor("org_alert_slack", "apr_ok"), null);
    expect(results.some((r) => r.ok)).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test("Slack rejects the post: alert with reason + inbox id, approval untouched", async () => {
    slackReply = { ok: false, error: "channel_not_found" };
    const results = await sendApprovalNotifications(approvalFor("org_alert_slack", "apr_fail"), null);
    expect(results.some((r) => r.ok)).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ orgId: "org_alert_slack", kind: "delivery_failed", approvalId: "apr_fail", provider: "slack" });
    expect(String(alerts[0].reason)).toContain("channel_not_found");
    expect(typeof alerts[0].channelId).toBe("string");
  });

  test("org with no approval inbox: alert no_approval_inbox", async () => {
    await sendApprovalNotifications(approvalFor("org_alert_none", "apr_none"), null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ orgId: "org_alert_none", reason: "no_approval_inbox", channelId: null });
  });

  test("flag OFF: no alert", async () => {
    alertOn = false;
    slackReply = { ok: false, error: "channel_not_found" };
    await sendApprovalNotifications(approvalFor("org_alert_slack", "apr_off"), null);
    expect(alerts).toHaveLength(0);
  });
});
