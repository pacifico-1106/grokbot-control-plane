import { describe, expect, test } from "bun:test";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import {
  evaluateW2Eligibility,
  isApprovedUnfulfilled,
} from "@/lib/stuck-watch/w2-unfulfilled";
import type { ApprovalRequest } from "@/lib/types";

function makeApproval(
  overrides: Partial<ApprovalRequest> = {}
): ApprovalRequest {
  const now = new Date().toISOString();
  return {
    id: "apr_w2_test",
    orgId: "org_demo",
    employeeId: "emp_demo",
    credentialId: "emp_demo",
    title: "test",
    purpose: "comm.reply",
    summary: "summary",
    risk: "medium",
    status: "approved",
    tool: "comm.reply",
    jobId: "job_w2_test",
    createdAt: now,
    resolvedAt: now,
    resolvedBy: "owner@example.com",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: null, telegramMessageId: null, statusToken: "fixture",
    pollPath: "/api/approvals/status?id=x&token=y",
    metadata: {
      invoke: {
        tool: "comm.reply",
        purpose: "comm.reply",
        jobId: "job_w2_test",
        employeeId: "emp_demo",
        orgId: "org_demo",
        postingAs: "bot",
        conversation: { slackChannelId: "C1" },
        args: { text: "hello" },
      },
    },
    ...overrides,
  };
}

describe("isApprovedUnfulfilled", () => {
  test("approved without fulfillment is unfulfilled", () => {
    expect(isApprovedUnfulfilled(makeApproval())).toBe(true);
  });

  test("approved with ok fulfillment is fulfilled", () => {
    const approval = makeApproval({
      metadata: {
        invoke: makeApproval().metadata.invoke,
        fulfillment: {
          ok: true,
          delivery: "slack",
          channel: "C1",
          ts: "123.456",
          at: new Date().toISOString(),
        },
      },
    });
    expect(isApprovedUnfulfilled(approval)).toBe(false);
  });

  test("pending approval is not unfulfilled", () => {
    expect(isApprovedUnfulfilled(makeApproval({ status: "pending" }))).toBe(false);
  });
});

describe("evaluateW2Eligibility", () => {
  const policy = defaultStuckWatchPolicy();

  test("too soon before approvedUnfulfilledMinutes", () => {
    const approval = makeApproval({
      resolvedAt: new Date().toISOString(),
      metadata: {
        ...makeApproval().metadata,
        stuckWatch: {
          w2: {
            firstDetectedAt: new Date().toISOString(),
            retryCount: 0,
          },
        },
      },
    });
    const result = evaluateW2Eligibility({
      approval,
      policy,
      now: new Date(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("too_soon");
  });

  test("eligible after threshold with retries remaining", () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    const approval = makeApproval({
      resolvedAt: sixMinutesAgo,
      metadata: {
        ...makeApproval().metadata,
        stuckWatch: {
          w2: {
            firstDetectedAt: sixMinutesAgo,
            retryCount: 0,
          },
        },
      },
    });
    const result = evaluateW2Eligibility({
      approval,
      policy,
      now: new Date(),
    });
    expect(result.eligible).toBe(true);
    expect(result.retryCount).toBe(0);
  });

  test("max retries reached", () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    const approval = makeApproval({
      resolvedAt: sixMinutesAgo,
      metadata: {
        ...makeApproval().metadata,
        stuckWatch: {
          w2: {
            firstDetectedAt: sixMinutesAgo,
            retryCount: 2,
          },
        },
      },
    });
    const result = evaluateW2Eligibility({
      approval,
      policy: { ...policy, maxAutoRetries: 2 },
      now: new Date(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("max_retries");
  });

  test("disabled policy is not eligible", () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    const approval = makeApproval({ resolvedAt: sixMinutesAgo });
    const result = evaluateW2Eligibility({
      approval,
      policy: { ...policy, enabled: false },
      now: new Date(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("disabled");
  });
});
