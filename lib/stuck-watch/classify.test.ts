import { describe, expect, test } from "bun:test";
import { classifyInvokeFailure } from "@/lib/stuck-watch/classify";

describe("classifyInvokeFailure", () => {
  test("needs_approval → expected_gate / wait_approval", () => {
    const result = classifyInvokeFailure({
      code: "needs_approval",
      needs_approval: true,
    });
    expect(result).toEqual({
      faultClass: "expected_gate",
      stuckHint: "wait_approval",
    });
  });

  test("scope_denied → expected_gate", () => {
    const result = classifyInvokeFailure({ code: "scope_denied" });
    expect(result.faultClass).toBe("expected_gate");
    expect(result.stuckHint).not.toBe("retryable");
  });

  test("high_risk_consent_required → expected_gate", () => {
    const result = classifyInvokeFailure({ code: "high_risk_consent_required" });
    expect(result.faultClass).toBe("expected_gate");
  });

  test("expired_trial_gated → ops_fault / retryable", () => {
    const result = classifyInvokeFailure({ code: "expired_trial_gated" });
    expect(result).toEqual({
      faultClass: "ops_fault",
      stuckHint: "retryable",
    });
  });

  test("approved unfulfilled → ops_fault / retryable", () => {
    const result = classifyInvokeFailure({ code: "", approvedUnfulfilled: true });
    expect(result.faultClass).toBe("ops_fault");
    expect(result.stuckHint).toBe("retryable");
  });

  test("5xx → ops_fault / retryable", () => {
    const result = classifyInvokeFailure({
      code: "slack_post_failed",
      httpStatus: 502,
    });
    expect(result.faultClass).toBe("ops_fault");
    expect(result.stuckHint).toBe("retryable");
  });

  test("egress_denied + internal ledger + unknown audience → ops_fault", () => {
    const result = classifyInvokeFailure({
      code: "egress_denied",
      egress: { audience: "unknown" },
      hasInternalLedger: true,
    });
    expect(result.faultClass).toBe("ops_fault");
    expect(result.stuckHint).toBe("retryable");
  });

  test("egress_denied without ledger → config_drift / fix", () => {
    const result = classifyInvokeFailure({
      code: "egress_denied",
      egress: { audience: "unknown" },
      hasInternalLedger: false,
    });
    expect(result).toEqual({
      faultClass: "config_drift",
      stuckHint: "fix",
    });
  });

  test("unbound → config_drift / fix", () => {
    const result = classifyInvokeFailure({ code: "unbound" });
    expect(result).toEqual({
      faultClass: "config_drift",
      stuckHint: "fix",
    });
  });

  test("missing_scope → config_drift", () => {
    const result = classifyInvokeFailure({ code: "missing_scope" });
    expect(result.faultClass).toBe("config_drift");
  });
});
