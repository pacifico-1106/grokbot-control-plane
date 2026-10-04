/**
 * pollHint for the approval status poll (GET /api/approvals/status) and MCP
 * staffpass_get_approval_status — one rule for both.
 *
 * #253 follow-up 4: while the approved attachment is `not_sent` (only the
 * approved text was posted), the agent must re-invoke with the approvalId to
 * upload it, so the hint is reinvoke_with_approvalId instead of fulfilled.
 * The same holds once the scheduled reconcile has found the file was never
 * shared (status failed, code reconcile_not_found; #253 follow-up 1).
 */
export function approvalPollHint(input: {
  status: string;
  approvalId: string;
  fulfillmentResult: { fileUpload?: unknown } | null | undefined;
  adminResultRequired: boolean;
}): string {
  const { status, fulfillmentResult, adminResultRequired } = input;
  if (status === "pending") return "continue_polling";
  if (status === "approved") {
    if (!fulfillmentResult || adminResultRequired) return "reinvoke_with_approvalId";
    return attachmentNotSent(fulfillmentResult.fileUpload) ? "reinvoke_with_approvalId" : "fulfilled";
  }
  if (status === "revision_requested") {
    return `Revise the artifact per revisionNote and re-invoke with the same jobId and parentApprovalId=${input.approvalId}.`;
  }
  return "abort_job";
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

export const RECONCILE_NOT_FOUND = "reconcile_not_found";
