/**
 * pollHint for the approval status poll (GET /api/approvals/status) and MCP
 * staffpass_get_approval_status — one rule for both.
 *
 * #253 follow-up 4: while the approved attachment is `not_sent` (only the
 * approved text was posted), the agent must re-invoke with the approvalId to
 * upload it, so the hint is reinvoke_with_approvalId instead of fulfilled.
 * The same holds once the scheduled reconcile has found the file was never
 * shared (status failed, code reconcile_not_found; #253 follow-up 1).
 *
 * 木村 5 (2026-10-04): the same hint when the upload failed because Slack
 * answered a definite pre-share error (lib/slack/definite-errors.ts), plus a
 * machine-readable `reinvokeReason` (what to fix, which admin tool to run
 * next) so the agent decides its next step itself. Use approvalPollFields so
 * both surfaces return the same shape.
 */
import { isSlackTokenType, slackReinvokeReason, type SlackReinvokeReason } from "@/lib/slack/definite-errors";

type PollInput = {
  status: string;
  approvalId: string;
  fulfillmentResult: { fileUpload?: unknown } | null | undefined;
  adminResultRequired: boolean;
};

export function approvalPollHint(input: PollInput): string {
  const { status, fulfillmentResult, adminResultRequired } = input;
  if (status === "pending") return "continue_polling";
  if (status === "approved") {
    if (!fulfillmentResult || adminResultRequired) return "reinvoke_with_approvalId";
    const upload = fulfillmentResult.fileUpload;
    return attachmentNotSent(upload) || definiteFailure(upload) ? "reinvoke_with_approvalId" : "fulfilled";
  }
  if (status === "revision_requested") {
    return `Revise the artifact per revisionNote and re-invoke with the same jobId and parentApprovalId=${input.approvalId}.`;
  }
  return "abort_job";
}

/** Why the agent should re-invoke (definite Slack failure only); null otherwise. */
export function approvalReinvokeReason(input: PollInput): SlackReinvokeReason | null {
  if (input.status !== "approved" || !input.fulfillmentResult || input.adminResultRequired) return null;
  return definiteFailure(input.fulfillmentResult.fileUpload);
}

/** { pollHint, reinvokeReason? } — spread into the status API and the MCP tool response. */
export function approvalPollFields(input: PollInput): { pollHint: string; reinvokeReason?: SlackReinvokeReason } {
  const reinvokeReason = approvalReinvokeReason(input);
  return { pollHint: approvalPollHint(input), ...(reinvokeReason ? { reinvokeReason } : {}) };
}

/**
 * not_sent, or the scheduled reconcile found the file was never shared
 * (failed / reconcile_not_found): the re-invoke uploads it once.
 */
function attachmentNotSent(fileUpload: unknown): boolean {
  if (!fileUpload || typeof fileUpload !== "object") return false;
  const { status, code } = fileUpload as { status?: unknown; code?: unknown };
  return status === "not_sent" || (status === "failed" && code === RECONCILE_NOT_FOUND);
}

/** failed + a definite pre-share Slack error → the reason (fix it, then re-invoke). */
function definiteFailure(fileUpload: unknown): SlackReinvokeReason | null {
  return reinvokeReasonForFileUpload(fileUpload);
}

export const RECONCILE_NOT_FOUND = "reconcile_not_found";

/**
 * THE builder of reinvokeReason (木村 #255 second round, decision 3): the status
 * poll / MCP (via approvalPollFields) and the approved re-run response
 * (lib/approvals/approved-rerun-attachment.ts) both pass the fulfillment-style
 * view of the upload record ({ status:"failed", slackError, slackNeeded?,
 * slackTokenType? }) through this one function.
 */
export function reinvokeReasonForFileUpload(fileUpload: unknown): SlackReinvokeReason | null {
  if (!fileUpload || typeof fileUpload !== "object") return null;
  const { status, slackError, slackNeeded, slackTokenType } = fileUpload as {
    status?: unknown; slackError?: unknown; slackNeeded?: unknown; slackTokenType?: unknown;
  };
  if (status !== "failed" || typeof slackError !== "string") return null;
  return slackReinvokeReason(
    slackError,
    Array.isArray(slackNeeded) ? slackNeeded.filter((s): s is string => typeof s === "string") : undefined,
    isSlackTokenType(slackTokenType) ? slackTokenType : undefined
  );
}
