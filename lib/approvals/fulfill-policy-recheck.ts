/**
 * Re-check tool settings and mail policy right before an approved item is
 * executed (fulfill). Settings may have changed after the human approved:
 * if the current settings would now deny / reject / demote, the approved
 * send is stopped (not sent), the reason is audited, and a clear error code
 * is returned. Stricter-only: this adds a stop, never an allow.
 *
 * Applies to outbound-send tools (lib/gateway/tools.ts OUTBOUND_SEND_TOOL_IDS).
 */
import { createHash } from "node:crypto";
import { appendAuditEvent } from "@/lib/data/audit";
import { conversationOrgMismatch } from "@/lib/gateway/audience";
import { getEmployeeById } from "@/lib/data/employees";
import { isOutboundSendTool } from "@/lib/gateway/tools";
import { evaluateMailPolicyForRequest } from "@/lib/mail-policy/evaluate-request";
import type { ApprovalRequest } from "@/lib/types";
import type { InvokeSnapshot } from "./fulfill";

/** Known to precede any provider effect (safe to mark the claim failed, not uncertain). */
export const FULFILL_POLICY_BLOCK_CODES = [
  "fulfill_blocked_tool_denied",
  "fulfill_blocked_mail_policy",
  "fulfill_blocked_employee_unavailable",
  "fulfill_blocked_conversation_org_mismatch",
] as const;
export type FulfillPolicyBlockCode = (typeof FULFILL_POLICY_BLOCK_CODES)[number];

export type FulfillPolicyRecheck =
  | { ok: true }
  | {
      ok: false;
      code: FulfillPolicyBlockCode;
      /** Underlying reason (e.g. mail_domain_denied, mail_send_demoted_to_draft, deny). */
      reason: string;
      messageJa: string;
      detail?: Record<string, unknown>;
    };

export async function recheckPolicyAtFulfill(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot
): Promise<FulfillPolicyRecheck> {
  const tool = snapshot.tool || approval.tool || "";
  // Tenant isolation: execution is bound to the approval ROW's org. A snapshot
  // whose conversation names another org (e.g. created before the fix with a
  // forged conversation.orgId) is refused for every tool, before any provider
  // call. Only a hash of the supplied org is audited (under the row's org).
  const orgMismatch = conversationOrgMismatch(snapshot.conversation, approval.orgId);
  if (orgMismatch) {
    return {
      ok: false,
      code: "fulfill_blocked_conversation_org_mismatch",
      reason: "conversation_org_mismatch",
      messageJa:
        "この承認の会話先が承認した組織と一致しないため、実行を停止しました（送信していません）。必要であれば同じ内容で承認を取り直してください。",
      detail: {
        suppliedOrgIdSha256: createHash("sha256").update(orgMismatch.suppliedOrgId).digest("hex"),
      },
    };
  }
  if (!isOutboundSendTool(tool)) return { ok: true };

  const employeeId = approval.employeeId;
  const employee = employeeId ? await getEmployeeById(employeeId) : null;
  if (!employee || employee.orgId !== approval.orgId) {
    return {
      ok: false,
      code: "fulfill_blocked_employee_unavailable",
      reason: employee ? "employee_org_mismatch" : "employee_not_found",
      messageJa: "社員の現在の設定を確認できないため、承認済みの送信を停止しました（送信していません）。",
    };
  }

  if (employee.toolApprovalDefaults?.[tool] === "deny") {
    return {
      ok: false,
      code: "fulfill_blocked_tool_denied",
      reason: "deny",
      messageJa: `承認後にツール設定で ${tool} が禁止（deny）されたため、承認済みの送信を停止しました（送信していません）。`,
      detail: { toolHint: "deny" },
    };
  }

  if (tool === "mail.send") {
    const { decision, to } = await evaluateMailPolicyForRequest({
      orgId: approval.orgId,
      employeeId,
      body: { args: snapshot.args, conversation: snapshot.conversation },
    });
    if (decision.rejected || decision.demotedToDraft) {
      return {
        ok: false,
        code: "fulfill_blocked_mail_policy",
        reason: decision.rejected
          ? decision.rejectCode || "mail_policy_rejected"
          : "mail_send_demoted_to_draft",
        messageJa:
          "承認後にメールポリシーが変わり、この送信は現在の設定では許可されないため停止しました（送信していません）。",
        detail: {
          to,
          sendMode: decision.sendMode,
          audience: decision.audience,
          auditLabels: decision.auditLabels,
          appliedRules: decision.appliedRules,
        },
      };
    }
  }

  return { ok: true };
}

export async function auditFulfillPolicyBlock(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot,
  block: Extract<FulfillPolicyRecheck, { ok: false }>
): Promise<void> {
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action: "tool.invoke",
    purpose: approval.purpose,
    summary: `承認済みの ${snapshot.tool || approval.tool} を実行直前の再確認で停止（未送信）`,
    metadata: {
      approvalId: approval.id,
      tool: snapshot.tool || approval.tool,
      jobId: snapshot.jobId || approval.jobId,
      code: block.code,
      reason: block.reason,
      phase: "approval.fulfill",
      ...(block.detail ?? {}),
    },
  });
}
