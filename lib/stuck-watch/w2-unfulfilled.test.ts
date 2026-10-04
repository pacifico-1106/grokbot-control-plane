import { describe, expect, test } from "bun:test";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import * as w2 from "@/lib/stuck-watch/w2-unfulfilled";
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

describe("W2 auto-retry exclusion (manual re-invoke only)", () => {
  const policy = defaultStuckWatchPolicy();
  const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000).toISOString();

  function adminApproval(tool: string): ApprovalRequest {
    const at = tenMinutesAgo();
    return makeApproval({
      id: `apr_w2_admin_${tool}`,
      tool,
      purpose: "admin.policy",
      resolvedAt: at,
      metadata: {
        approvalClass: "admin",
        auditClass: "admin",
        always_human: true,
        adminTool: tool,
        adminMutation: {},
        adminFulfillment: { ok: false, tool, at, error: "user_token_missing" },
        stuckWatch: { w2: { firstDetectedAt: at, retryCount: 0 } },
      },
    });
  }

  test("the exclusion list is explicit and holds only employees.postingIdentity.set", () => {
    const list = (w2 as Record<string, unknown>).W2_MANUAL_REINVOKE_ONLY_TOOLS as ReadonlySet<string> | undefined;
    expect(list instanceof Set).toBe(true);
    expect([...(list ?? [])]).toEqual(["employees.postingIdentity.set"]);
  });

  test("employees.postingIdentity.set: still tracked as unfulfilled, never eligible (retries left, policy on)", () => {
    const approval = adminApproval("employees.postingIdentity.set");
    expect(isApprovedUnfulfilled(approval)).toBe(true);
    const result = evaluateW2Eligibility({ approval, policy, now: new Date() });
    expect(result).toMatchObject({ eligible: false, reason: "manual_reinvoke_required", retryCount: 0 });
  });

  test("other tools are unchanged: admin tools and business invokes stay eligible", () => {
    for (const tool of ["policy.patch", "employees.allowedAccounts.add", "setup.slackAuthorizeLink.issue"]) {
      const result = evaluateW2Eligibility({ approval: adminApproval(tool), policy, now: new Date() });
      expect({ tool, eligible: result.eligible, reason: result.reason }).toEqual({ tool, eligible: true, reason: undefined });
    }
    const at = tenMinutesAgo();
    const invoke = makeApproval({
      resolvedAt: at,
      metadata: { ...makeApproval().metadata, stuckWatch: { w2: { firstDetectedAt: at, retryCount: 0 } } },
    });
    expect(evaluateW2Eligibility({ approval: invoke, policy, now: new Date() }).eligible).toBe(true);
    // Existing reasons keep their order for other tools.
    expect(evaluateW2Eligibility({ approval: adminApproval("policy.patch"), policy: { ...policy, enabled: false }, now: new Date() }).reason).toBe("disabled");
    expect(evaluateW2Eligibility({ approval: adminApproval("policy.patch"), policy: { ...policy, maxAutoRetries: 0 }, now: new Date() }).reason).toBe("max_retries");
  });

  test("the excluded tool also reports disabled / not_unfulfilled first (no new state for those)", () => {
    const approval = adminApproval("employees.postingIdentity.set");
    expect(evaluateW2Eligibility({ approval, policy: { ...policy, enabled: false }, now: new Date() }).reason).toBe("disabled");
    const done = { ...approval, metadata: { ...approval.metadata, adminFulfillment: { ok: true, tool: approval.tool, at: tenMinutesAgo() } } };
    expect(evaluateW2Eligibility({ approval: done, policy, now: new Date() }).reason).toBe("not_unfulfilled");
  });
});
