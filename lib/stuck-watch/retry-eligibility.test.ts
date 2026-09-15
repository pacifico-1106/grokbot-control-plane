import { describe, expect, test } from "bun:test";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import {
  canAutoRetryOpsFault,
  prepareOpsFaultRetryInvokeBody,
  sendConfirmToolRequiresGateReevaluation,
} from "@/lib/stuck-watch/retry-eligibility";

describe("canAutoRetryOpsFault", () => {
  const policy = defaultStuckWatchPolicy();

  test("expected_gate never auto-retries", () => {
    expect(
      canAutoRetryOpsFault({
        faultClass: "expected_gate",
        policy,
        retryCount: 0,
      })
    ).toBe(false);
    expect(
      canAutoRetryOpsFault({
        faultClass: "expected_gate",
        policy,
        retryCount: 0,
      })
    ).toBe(false);
  });

  test("ops_fault retries within maxAutoRetries", () => {
    expect(
      canAutoRetryOpsFault({
        faultClass: "ops_fault",
        policy,
        retryCount: 0,
      })
    ).toBe(true);
    expect(
      canAutoRetryOpsFault({
        faultClass: "ops_fault",
        policy,
        retryCount: 1,
      })
    ).toBe(true);
    expect(
      canAutoRetryOpsFault({
        faultClass: "ops_fault",
        policy,
        retryCount: 2,
      })
    ).toBe(false);
  });

  test("config_drift is not in default autoRetryFaultClasses", () => {
    expect(
      canAutoRetryOpsFault({
        faultClass: "config_drift",
        policy,
        retryCount: 0,
      })
    ).toBe(false);
  });

  test("disabled policy blocks retry", () => {
    expect(
      canAutoRetryOpsFault({
        faultClass: "ops_fault",
        policy: { ...policy, enabled: false },
        retryCount: 0,
      })
    ).toBe(false);
  });
});

describe("send/confirm gate re-evaluation on retry", () => {
  test("send/confirm tools require gate reevaluation", () => {
    expect(sendConfirmToolRequiresGateReevaluation("mail.send")).toBe(true);
    expect(sendConfirmToolRequiresGateReevaluation("calendar.confirm")).toBe(true);
    expect(sendConfirmToolRequiresGateReevaluation("comm.reply")).toBe(true);
    expect(sendConfirmToolRequiresGateReevaluation("calendar.propose")).toBe(false);
  });

  test("prepareOpsFaultRetryInvokeBody strips approvalId for send/confirm", () => {
    const body = {
      tool: "mail.send",
      purpose: "notify",
      jobId: "job_retry_1",
      approvalId: "apr_prior",
      args: { to: "a@example.com", subject: "hi", body: "test" },
    };
    const prepared = prepareOpsFaultRetryInvokeBody(body);
    expect(prepared.approvalId).toBeUndefined();
    expect(prepared.jobId).toBe("job_retry_1");
    expect(prepared.tool).toBe("mail.send");
  });

  test("non-send tools keep approvalId when present", () => {
    const body = {
      tool: "calendar.propose",
      purpose: "schedule",
      jobId: "job_retry_2",
      approvalId: "apr_prior",
      args: {},
    };
    const prepared = prepareOpsFaultRetryInvokeBody(body);
    expect(prepared.approvalId).toBe("apr_prior");
  });
});
