/** STUB (tests first). */
import type { ApprovalRequest } from "@/lib/types";

export const DEFAULT_RECONCILE_STALE_MINUTES = 10;
export type AttachmentReconcileResult = {
  approvalId: string;
  from: "running" | "uncertain";
  outcome: "succeeded" | "failed" | "uncertain" | "skipped";
  code: string;
  notified?: boolean;
  applied: boolean;
};
export type AttachmentReconcileRun = {
  enabled: boolean;
  results: AttachmentReconcileResult[];
  notSentMarked: string[];
};

export async function runApprovalAttachmentReconcile(
  _approvals: ApprovalRequest[],
  _opts: { now?: Date } = {}
): Promise<AttachmentReconcileRun> {
  return { enabled: false, results: [], notSentMarked: [] };
}
