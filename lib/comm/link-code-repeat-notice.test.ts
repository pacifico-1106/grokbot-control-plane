/** 木村 10/12: 3 account locks within 24 h → ops AND the tenant's approvers (inbox), IDs only. */
import { describe, expect, mock, test } from "bun:test";

const ORG = "ec000000-0000-4000-8000-000000000001";
const sent: Array<{ channel: string; text: string }> = [];
const audits: Array<Record<string, unknown>> = [];
const mails: Array<Record<string, unknown>> = [];
mock.module("@/lib/data/audit", () => ({ appendAuditEvent: async (e: Record<string, unknown>) => { audits.push(e); } }));
mock.module("@/lib/data/notification-channels", () => ({
  getEnabledNotificationChannels: async (orgId: string) => [
    { id: "chn-other", orgId: "someone-else", isDefault: true },
    { id: "chn-default", orgId, isDefault: true },
  ],
}));
mock.module("@/lib/notify/channels", () => ({
  sendApprovalInboxText: async (c: { id: string }, text: string) => { sent.push({ channel: c.id, text }); },
}));
mock.module("@/lib/resend", () => ({ sendTransactionalEmail: async (m: Record<string, unknown>) => { mails.push(m); } }));

const { notifyLinkCodeAccountLockedRepeat } = await import("@/lib/comm/link-code-guard");

describe("repeat-lock notice", () => {
  test("goes to this org's approval inbox and to ops; no LINE userId, no code", async () => {
    process.env.APPROVAL_ALERT_OPS_EMAILS = "ops@example.com";
    try {
      await notifyLinkCodeAccountLockedRepeat({ orgId: ORG, accountKey: "comm_account:ec200000-0000-4000-8000-000000000001", reason: "link_code_account_locked_repeat" });
    } finally {
      delete process.env.APPROVAL_ALERT_OPS_EMAILS;
    }
    expect(sent.map((s) => s.channel)).toEqual(["chn-default"]);
    expect(sent[0].text).toContain("3 回");
    expect(mails.length).toBe(1);
    expect(audits.map((a) => a.action)).toEqual(["comm.link_code_account_locked_repeat"]);
    expect(JSON.stringify({ sent, mails, audits })).not.toMatch(/U[0-9a-f]{32}|SP-[A-Z0-9]{4}/);
  });
});
