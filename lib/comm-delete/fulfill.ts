/**
 * Approved comm.delete: everything is checked again at execution time (the
 * flag, the employee, a per-tool deny, the employee's own record, already
 * deleted). The human approval never widens what may be deleted.
 */
import type { ApprovalFulfillment } from "@/lib/approvals/fulfill";
import { getEmployeeById } from "@/lib/data/employees";
import type { ApprovalRequest } from "@/lib/types";
import { isCommDeleteEnabled, COMM_DELETE_TOOL_ID } from "./config";
import { auditCommDelete, executeCommDelete, type CommDeleteContext } from "./run";
import { parseCommDeleteTarget } from "./target";

export async function fulfillCommDeleteApproval(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<ApprovalFulfillment> {
  const at = new Date().toISOString();
  const ctx: CommDeleteContext = {
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    purpose: approval.purpose,
    jobId: approval.jobId || "",
    approvalId: approval.id,
    phase: "approval.fulfill",
  };
  const stop = async (code: string): Promise<ApprovalFulfillment> => {
    await auditCommDelete(ctx, "comm.delete.refused", null, { code }, `承認済みの ${COMM_DELETE_TOOL_ID} を実行直前に停止（${code}）`);
    return { ok: false, error: code, at, commDelete: { status: "refused", code } };
  };

  if (!isCommDeleteEnabled()) return stop("comm_delete_disabled");
  const employee = approval.employeeId ? await getEmployeeById(approval.employeeId).catch(() => null) : null;
  if (!employee || employee.orgId !== approval.orgId) return stop("fulfill_blocked_employee_unavailable");
  if (employee.toolApprovalDefaults?.[COMM_DELETE_TOOL_ID] === "deny") return stop("fulfill_blocked_tool_denied");

  const parsed = parseCommDeleteTarget(args);
  if (!parsed.ok) return stop("invalid_delete_target");

  const o = await executeCommDelete(ctx, parsed.target);
  const commDelete = { status: o.status, code: o.code, ...(o.deletedVia ? { deletedVia: o.deletedVia } : {}) };
  if (!o.ok) return { ok: false, error: o.code, at, commDelete };
  return {
    ok: true,
    delivery: o.delivery ?? "slack",
    channel: o.target.channel,
    ts: o.target.messageId,
    surface: o.target.surface,
    at,
    commDelete,
  };
}
