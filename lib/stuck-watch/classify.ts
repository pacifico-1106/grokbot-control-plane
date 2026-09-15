import type { FaultClass, StuckHint } from "@/lib/types";

export type ClassifyInvokeFailureInput = {
  code: string;
  error?: string | null;
  needs_approval?: boolean;
  httpStatus?: number;
  egress?: {
    reason?: string;
    audience?: string;
    effectiveAudience?: string;
  } | null;
  /** When true, internal audience ledger is configured for the org. */
  hasInternalLedger?: boolean;
  /** approved + fulfill incomplete */
  approvedUnfulfilled?: boolean;
};

export type ClassifyInvokeFailureResult = {
  faultClass: FaultClass;
  stuckHint: StuckHint;
};

const EXPECTED_GATE_CODES = new Set([
  "needs_approval",
  "scope_denied",
  "scope_required",
  "purpose_denied",
  "purpose_not_allowed",
  "deny",
  "action_limit_denied",
  "high_risk_consent_required",
  "voice_forbidden",
  "mail_send_rejected",
  "mail_domain_denied",
  "mail_attachment_forbidden",
  "project_scope_denied",
  "project_access_denied",
  "invalid_parent_approval",
]);

const OPS_FAULT_CODES = new Set([
  "expired_trial_gated",
  "slack_post_failed",
  "sns_publish_failed",
  "slack_not_in_channel",
  "timeout",
  "gateway_timeout",
  "upstream_error",
  "approved_unfulfilled",
]);

const CONFIG_DRIFT_CODES = new Set([
  "unbound",
  "employee_id_required",
  "not_found",
  "employee_not_found",
  "missing_scope",
  "slack_identity_unbound",
  "unknown_tool",
  "tool_required",
  "purpose_required",
  "job_id_required",
]);

function stuckHintFor(
  faultClass: FaultClass,
  code: string,
  needsApproval?: boolean
): StuckHint {
  if (faultClass === "ops_fault") return "retryable";
  if (faultClass === "config_drift") return "fix";
  if (needsApproval || code === "needs_approval") return "wait_approval";
  return "fix";
}

function isServerError(httpStatus?: number, code?: string): boolean {
  if (httpStatus && httpStatus >= 500) return true;
  const value = (code || "").toLowerCase();
  return (
    value.includes("timeout") ||
    value.includes("5xx") ||
    value.endsWith("_failed") &&
      !value.includes("post_failed") &&
      !value.includes("publish_failed")
  );
}

export function classifyInvokeFailure(
  input: ClassifyInvokeFailureInput
): ClassifyInvokeFailureResult {
  const code = (input.code || input.error || "").trim();
  const lower = code.toLowerCase();

  if (input.approvedUnfulfilled) {
    return { faultClass: "ops_fault", stuckHint: "retryable" };
  }

  if (input.needs_approval || lower === "needs_approval") {
    return {
      faultClass: "expected_gate",
      stuckHint: "wait_approval",
    };
  }

  if (OPS_FAULT_CODES.has(lower)) {
    return {
      faultClass: "ops_fault",
      stuckHint: "retryable",
    };
  }

  if (lower === "egress_denied") {
    const audience =
      input.egress?.audience || input.egress?.effectiveAudience || "";
    const audienceMissing =
      !audience || audience === "unknown" || audience === "external";
    if (input.hasInternalLedger && audienceMissing) {
      return { faultClass: "ops_fault", stuckHint: "retryable" };
    }
    return { faultClass: "config_drift", stuckHint: "fix" };
  }

  if (EXPECTED_GATE_CODES.has(lower)) {
    return {
      faultClass: "expected_gate",
      stuckHint: stuckHintFor("expected_gate", lower, input.needs_approval),
    };
  }

  if (CONFIG_DRIFT_CODES.has(lower)) {
    return { faultClass: "config_drift", stuckHint: "fix" };
  }

  if (isServerError(input.httpStatus, lower)) {
    return { faultClass: "ops_fault", stuckHint: "retryable" };
  }

  if (lower.startsWith("mail_") && lower.includes("denied")) {
    return { faultClass: "expected_gate", stuckHint: "fix" };
  }

  if (input.httpStatus && input.httpStatus >= 400 && input.httpStatus < 500) {
    return { faultClass: "expected_gate", stuckHint: "fix" };
  }

  return { faultClass: "ops_fault", stuckHint: "retryable" };
}
