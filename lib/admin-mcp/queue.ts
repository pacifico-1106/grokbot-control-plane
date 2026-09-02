/**
 * Always-human queue for admin MCP tools.
 * Create an approval ticket; do not mutate until a different human approves.
 */
import { sendApprovalNeededEmail } from "@/lib/email";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { appendAuditEvent, createApproval } from "@/lib/data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { auditActionForAdminTool, ADMIN_AUDIT_CLASS, isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
export { isAdminClassApproval };
import type { AdminRequester } from "@/lib/admin-mcp/self-approval";

const TOOL_TITLE_JA: Record<string, string> = {
  "employees.issue": "AI社員の発行",
  link: "AI社員の連携",
  "policy.patch": "権限の更新",
  "parties.upsert": "相手台帳の更新",
  "channels.classify": "チャネル分類",
  "roles.propose": "職務案の提案",
};

export type AdminQueueResult = {
  needs_approval: true;
  ok: false;
  code: "needs_approval";
  approvalId: string | null;
  statusToken: string | null;
  pollUrl: string | null;
  pollPath: string | null;
  pollHint: "continue_polling";
  title: string;
  summary: string;
  tool: string;
  always_human: true;
  auditClass: typeof ADMIN_AUDIT_CLASS;
  auditAction: string;
};

export async function queueAdminTool(input: {
  cred: ResolvedAdminCredential;
  tool: string;
  args: Record<string, unknown>;
  title?: string;
  summary: string;
  jobId?: string;
}): Promise<AdminQueueResult> {
  const auditAction = auditActionForAdminTool(input.tool);
  const title = input.title || TOOL_TITLE_JA[input.tool] || input.tool;
  const jobId =
    input.jobId ||
    (typeof input.args.jobId === "string" ? input.args.jobId : "") ||
    `admin_${input.tool}_${Date.now().toString(36)}`;
  const requester: AdminRequester = {
    kind: "admin_agent",
    grokBotAgentId: input.cred.grokBotAgentId,
    actorId: input.cred.actorId,
  };
  const created = await createApproval({
    orgId: input.cred.orgId,
    employeeId: "",
    credentialId: input.cred.adminAgentId,
    title,
    purpose: auditAction,
    summary: input.summary,
    risk: "high",
    tool: input.tool,
    jobId,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      auditAction,
      always_human: true,
      adminTool: input.tool,
      adminMutation: input.args,
      adminRequester: requester,
    },
  });

  await appendAuditEvent({
    orgId: input.cred.orgId,
    employeeId: null,
    credentialId: input.cred.adminAgentId,
    action: auditAction,
    purpose: auditAction,
    summary: `承認待ち: ${title}`,
    metadata: {
      approvalId: created.approval.id,
      tool: input.tool,
      auditClass: ADMIN_AUDIT_CLASS,
      always_human: true,
    },
  });

  const notifyTo =
    process.env.BILLING_NOTIFY_EMAIL ||
    process.env.APPROVAL_NOTIFY_EMAIL ||
    "owner@example.com";
  void sendApprovalNeededEmail(notifyTo, created.approval.summary, "high").catch(
    () => null
  );
  void sendApprovalNotifications(created.approval, null).catch(() => null);

  return {
    ok: false,
    code: "needs_approval",
    needs_approval: true,
    approvalId: created.approval.id,
    statusToken: created.statusToken,
    pollUrl: created.pollUrl,
    pollPath: created.approval.pollPath,
    pollHint: "continue_polling",
    title,
    summary: created.approval.summary,
    tool: input.tool,
    always_human: true,
    auditClass: ADMIN_AUDIT_CLASS,
    auditAction,
  };
}
