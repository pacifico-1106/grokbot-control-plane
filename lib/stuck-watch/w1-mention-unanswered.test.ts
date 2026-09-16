import { describe, expect, test } from "bun:test";
import { pushRuntimeAuditEvent } from "@/lib/demo-data";
import { DEMO_ORG } from "@/lib/demo-data";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import {
  evaluateW1Eligibility,
  hasSuccessfulReplyAfterWake,
  inferW1BlockingContext,
  w1ItemId,
} from "@/lib/stuck-watch/w1-mention-unanswered";
import type { AuditEvent, ApprovalRequest } from "@/lib/types";

function makeWake(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const now = new Date();
  return {
    id: "aud_wake_1",
    orgId: DEMO_ORG.id,
    employeeId: "emp_comm",
    credentialId: null,
    action: "slack.mention_wake",
    purpose: "slack.mention",
    summary: "Slackメンションで社員を起こした",
    metadata: {
      reason: "woke",
      channel: "C_TEST",
      ts: "1503435956.000247",
      thread_ts: null,
      eventId: "Ev123",
    },
    createdAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeReplyAudit(wake: AuditEvent): AuditEvent {
  return {
    id: "aud_reply_1",
    orgId: wake.orgId,
    employeeId: wake.employeeId,
    credentialId: "cred_comm",
    action: "tool.invoke",
    purpose: "comm.internal",
    summary: "comm.reply を自動実行",
    metadata: {
      tool: "comm.reply",
      destination: "C_TEST",
      jobId: "job_reply_1",
    },
    createdAt: new Date(new Date(wake.createdAt).getTime() + 60_000).toISOString(),
  };
}

describe("w1ItemId", () => {
  test("stable id from channel and ts", () => {
    expect(w1ItemId("C_TEST", "1503435956.000247")).toBe(
      "w1:C_TEST:1503435956.000247"
    );
  });
});

describe("hasSuccessfulReplyAfterWake", () => {
  test("false when no reply audit exists", () => {
    const wake = makeWake();
    expect(hasSuccessfulReplyAfterWake(wake, [wake], [])).toBe(false);
  });

  test("true when comm.reply posted to same channel after wake", () => {
    const wake = makeWake();
    const reply = makeReplyAudit(wake);
    expect(hasSuccessfulReplyAfterWake(wake, [wake, reply], [])).toBe(true);
  });

  test("false when reply is to different channel", () => {
    const wake = makeWake();
    const reply = makeReplyAudit(wake);
    reply.metadata.destination = "C_OTHER";
    expect(hasSuccessfulReplyAfterWake(wake, [wake, reply], [])).toBe(false);
  });

  test("true when approved fulfillment exists after wake", () => {
    const wake = makeWake();
    const approval: ApprovalRequest = {
      id: "apr_fulfill",
      orgId: wake.orgId,
      employeeId: wake.employeeId!,
      credentialId: "cred_comm",
      title: "reply",
      purpose: "comm.internal",
      summary: "summary",
      risk: "medium",
      status: "approved",
      tool: "comm.reply",
      jobId: "job_f1",
      createdAt: wake.createdAt,
      resolvedAt: new Date(new Date(wake.createdAt).getTime() + 120_000).toISOString(),
      resolvedBy: "owner@example.com",
      revisionNote: null,
      revisionCount: 0,
      parentApprovalId: null,
      telegramRef: null, telegramMessageId: null, statusToken: "fixture",
      pollPath: "/x",
      metadata: {
        fulfillment: {
          ok: true,
          delivery: "slack",
          channel: "C_TEST",
          ts: "1503435957.000248",
          at: new Date().toISOString(),
        },
      },
    };
    expect(hasSuccessfulReplyAfterWake(wake, [wake], [approval])).toBe(true);
  });
});

describe("inferW1BlockingContext", () => {
  test("pending approval after wake → expected_gate", () => {
    const wake = makeWake();
    const pending: ApprovalRequest = {
      id: "apr_pending",
      orgId: wake.orgId,
      employeeId: wake.employeeId!,
      credentialId: "cred_comm",
      title: "reply",
      purpose: "comm.internal",
      summary: "summary",
      risk: "medium",
      status: "pending",
      tool: "comm.reply",
      jobId: "job_pending",
      createdAt: new Date(new Date(wake.createdAt).getTime() + 30_000).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      revisionNote: null,
      revisionCount: 0,
      parentApprovalId: null,
      telegramRef: null, telegramMessageId: null, statusToken: "fixture",
      pollPath: "/x",
      metadata: {},
    };
    const ctx = inferW1BlockingContext(wake, [wake], [pending]);
    expect(ctx.faultClass).toBe("expected_gate");
    expect(ctx.code).toBe("needs_approval");
    expect(ctx.approvalId).toBe("apr_pending");
  });

  test("no activity after wake → ops_fault mention_unanswered", () => {
    const wake = makeWake();
    const ctx = inferW1BlockingContext(wake, [wake], []);
    expect(ctx.faultClass).toBe("ops_fault");
    expect(ctx.code).toBe("mention_unanswered");
  });
});

describe("evaluateW1Eligibility", () => {
  const policy = defaultStuckWatchPolicy();

  test("too soon before mentionUnansweredMinutes", () => {
    const wake = makeWake({
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const result = evaluateW1Eligibility({
      wake,
      policy,
      audits: [wake],
      approvals: [],
      now: new Date(),
      resolvedItemIds: new Set(),
      notifiedItemIds: new Set(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("too_soon");
  });

  test("eligible after threshold with no reply", () => {
    const wake = makeWake();
    const result = evaluateW1Eligibility({
      wake,
      policy,
      audits: [wake],
      approvals: [],
      now: new Date(),
      resolvedItemIds: new Set(),
      notifiedItemIds: new Set(),
    });
    expect(result.eligible).toBe(true);
    expect(result.itemId).toBe("w1:C_TEST:1503435956.000247");
  });

  test("not eligible when already replied", () => {
    const wake = makeWake();
    const reply = makeReplyAudit(wake);
    const result = evaluateW1Eligibility({
      wake,
      policy,
      audits: [wake, reply],
      approvals: [],
      now: new Date(),
      resolvedItemIds: new Set(),
      notifiedItemIds: new Set(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("already_replied");
  });

  test("not eligible when resolved", () => {
    const wake = makeWake();
    const itemId = w1ItemId("C_TEST", "1503435956.000247");
    const result = evaluateW1Eligibility({
      wake,
      policy,
      audits: [wake],
      approvals: [],
      now: new Date(),
      resolvedItemIds: new Set([itemId]),
      notifiedItemIds: new Set(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("resolved");
  });

  test("disabled policy is not eligible", () => {
    const wake = makeWake();
    const result = evaluateW1Eligibility({
      wake,
      policy: { ...policy, enabled: false },
      audits: [wake],
      approvals: [],
      now: new Date(),
      resolvedItemIds: new Set(),
      notifiedItemIds: new Set(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("disabled");
  });
});

describe("evaluateW1Eligibility expected_gate blocking", () => {
  test("eligible for notify even when expected_gate (no auto-retry in W1 cron)", () => {
    const wake = makeWake();
    const pending: ApprovalRequest = {
      id: "apr_pending",
      orgId: wake.orgId,
      employeeId: wake.employeeId!,
      credentialId: "cred_comm",
      title: "reply",
      purpose: "comm.internal",
      summary: "summary",
      risk: "medium",
      status: "pending",
      tool: "comm.reply",
      jobId: "job_pending",
      createdAt: new Date(new Date(wake.createdAt).getTime() + 30_000).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      revisionNote: null,
      revisionCount: 0,
      parentApprovalId: null,
      telegramRef: null, telegramMessageId: null, statusToken: "fixture",
      pollPath: "/x",
      metadata: {},
    };
    const result = evaluateW1Eligibility({
      wake,
      policy: defaultStuckWatchPolicy(),
      audits: [wake],
      approvals: [pending],
      now: new Date(),
      resolvedItemIds: new Set(),
      notifiedItemIds: new Set(),
    });
    expect(result.eligible).toBe(true);
    expect(result.blocking.faultClass).toBe("expected_gate");
  });
});

describe("runtime audit integration", () => {
  test("pushRuntimeAuditEvent wake is detectable", () => {
    const event = pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake",
      metadata: { reason: "woke", channel: "C_RT", ts: "1.1" },
    });
    expect(event.metadata.reason).toBe("woke");
  });
});
