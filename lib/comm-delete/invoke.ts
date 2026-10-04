/**
 * Gateway entry for comm.delete (also reached through MCP staffpass_invoke).
 * Dispatched by runGatewayInvoke after identity / scope / purpose / plan /
 * action-limit checks and before any egress or posting logic.
 */
import { fulfillApprovedInvoke } from "@/lib/approvals/fulfill";
import { toolRequiresHumanApproval, type GatewayToolDef } from "@/lib/gateway/tools";
import type { ApprovalRequest, Employee } from "@/lib/types";
import { isCommDeleteEnabled, COMM_DELETE_TOOL_ID } from "./config";
import { auditCommDelete, executeCommDelete, precheckCommDelete, type CommDeleteContext, type CommDeleteOutcome } from "./run";
import { parseCommDeleteTarget } from "./target";

type Result = { httpStatus: number; body: Record<string, unknown> };

export type CommDeleteInvokeInput = {
  employee: Employee;
  orgId: string;
  credentialId: string | null;
  purpose: string;
  jobId: string;
  args: Record<string, unknown>;
  toolDef: GatewayToolDef;
  priorApprovalId: string;
  priorApprovalOk: boolean;
  priorApproval: ApprovalRequest | null;
  actionLimitNeedsApproval: boolean;
  json: (body: Record<string, unknown>, httpStatus?: number) => Result;
  requestApproval: (opts: {
    risk: "low";
    message: string;
    summaryPrefix: string;
    metadata: Record<string, unknown>;
    extra: Record<string, unknown>;
  }) => Promise<Result>;
};

function outcomeBody(input: CommDeleteInvokeInput, o: CommDeleteOutcome): Record<string, unknown> {
  return {
    ok: o.ok,
    code: o.code,
    ...(o.ok ? {} : { error: o.code }),
    status: o.status,
    message: o.messageJa,
    target: o.target,
    ...(o.deletedVia ? { deletedVia: o.deletedVia } : {}),
    ...(o.reason ? { reason: o.reason } : {}),
    ...(o.source ? { source: o.source } : {}),
    ...(o.needed ? { needed: o.needed } : {}),
    ...(o.maxAgeHours !== undefined ? { maxAgeHours: o.maxAgeHours } : {}),
    needs_approval: false,
    employeeId: input.employee.id,
    tool: COMM_DELETE_TOOL_ID,
    purpose: input.purpose,
    jobId: input.jobId,
  };
}

export async function runCommDeleteInvoke(input: CommDeleteInvokeInput): Promise<Result> {
  const { employee, purpose, jobId } = input;
  const ctx: CommDeleteContext = {
    orgId: input.orgId,
    employeeId: employee.id,
    credentialId: input.credentialId,
    purpose,
    jobId,
    approvalId: input.priorApprovalOk ? input.priorApprovalId : null,
    phase: "invoke",
  };
  const refuse = async (code: string, httpStatus: number, message: string, detail: Record<string, unknown> = {}) => {
    await auditCommDelete(ctx, "comm.delete.refused", null, { code, ...detail }, `comm.delete を拒否（${code}）`);
    return input.json({
      ok: false, code, error: code, status: "refused", message, needs_approval: false,
      employeeId: employee.id, tool: COMM_DELETE_TOOL_ID, purpose, jobId,
    }, httpStatus);
  };

  if (!isCommDeleteEnabled()) {
    return refuse("comm_delete_disabled", 403,
      "投稿の削除機能は無効です（COMM_DELETE_ENABLED が未設定）。管理者が有効化するまで削除できません。");
  }
  if (employee.toolApprovalDefaults?.[COMM_DELETE_TOOL_ID] === "deny") {
    return refuse("tool_denied_by_tool_setting", 403,
      "この社員のツール設定で comm.delete は禁止（deny）されています。", { toolHint: "deny" });
  }

  // Approved re-invoke: replay the stored result (never deletes twice).
  if (input.priorApprovalOk && input.priorApproval) {
    const f = await fulfillApprovedInvoke(input.priorApproval);
    const ok = Boolean(f?.ok);
    const code = f?.error || (ok ? "deleted" : "approval_execution_failed");
    return input.json({
      ok,
      code: ok ? "approved_delete_done" : code,
      ...(ok ? {} : { error: code }),
      status: ok ? "deleted_after_approval" : "failed",
      message: ok ? "承認済みの削除を実行済みです（再実行しても二重に削除しません）。" : "承認済みの削除を実行できませんでした。",
      approvalId: input.priorApprovalId,
      fulfillment: f,
      needs_approval: false,
      employeeId: employee.id, tool: COMM_DELETE_TOOL_ID, purpose, jobId,
    }, ok ? 200 : 409);
  }

  const parsed = parseCommDeleteTarget(input.args);
  if (!parsed.ok) {
    return refuse("invalid_delete_target", 400,
      parsed.messageJa, { field: parsed.field });
  }
  const target = parsed.target;

  const forceApproval =
    employee.approvalPolicy === "always_human" ||
    toolRequiresHumanApproval(input.toolDef, employee.toolApprovalDefaults) ||
    input.actionLimitNeedsApproval;

  if (forceApproval) {
    const refused = await precheckCommDelete(ctx, target);
    if (refused) return input.json(outcomeBody(input, refused), refused.httpStatus);
    await auditCommDelete(ctx, "comm.delete.approval_requested", target, { code: "needs_approval" }, "自分の投稿の削除を承認待ちに");
    return input.requestApproval({
      risk: "low",
      message: "自分の投稿の削除には人の承認が必要です（設定により）",
      summaryPrefix: `削除対象: ${target.surface} ${target.channel} の投稿（ID ${target.messageId}）。この社員自身が投稿し Staffpass に記録された投稿であることを確認済みです。本文は保存していません。`,
      metadata: { commDeleteTarget: target },
      extra: { target, toolKind: input.toolDef.kind, approvalPolicy: employee.approvalPolicy },
    });
  }

  const o = await executeCommDelete(ctx, target);
  return input.json(outcomeBody(input, o), o.httpStatus);
}
