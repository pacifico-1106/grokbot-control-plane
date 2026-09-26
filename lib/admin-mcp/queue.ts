/**
 * Always-human queue for admin MCP tools.
 * Create an approval ticket; do not mutate until a different human approves.
 * 
 * P0-A: Secret-in-chat detector integrated (fail-closed).
 * Secrets detected in args are rejected before approval ticket creation.
 *
 * P0 Item 1: Admin-class tickets require explicit account-approver policy
 * when ADMIN_APPROVER_POLICY_REQUIRED flag is enabled. If absent, fail-closed.
 */
import { sendApprovalNeededEmail } from "@/lib/email";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { appendAuditEvent, createApproval } from "@/lib/data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { auditActionForAdminTool, ADMIN_AUDIT_CLASS, isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
export { isAdminClassApproval };
import type { AdminRequester } from "@/lib/admin-mcp/self-approval";
import {
  detectSecretInPayload,
  buildSecretDetectionErrorResponse,
} from "@/lib/security/secret-detector";
import { checkAdminPolicyRequirement } from "@/lib/approval-workflow/admin-policy";
import { getOrgApprovalWorkflowPolicy } from "@/lib/approval-workflow/data";
import { isAdminApproverPolicyRequired } from "@/lib/feature-flags";

const TOOL_TITLE_JA: Record<string, string> = {
  "employees.issue": "AI社員の発行",
  link: "AI社員の連携",
  "policy.patch": "権限の更新",
  "parties.upsert": "相手台帳の更新",
  "channels.classify": "チャネル分類",
  "roles.propose": "職務案の提案",
  "ingressHandoff.patch": "受信の渡し方",
  "setup.slackAdapter.setBotToken": "Slack会話投稿Botトークン",
  "setup.lineApproval.upsert": "承認用LINEチャネル",
  "setup.lineApproval.setEmployeeInbox": "AI社員の承認インボックス（LINE）",
  "setup.lineApproval.demoteTelegram": "Telegram承認チャネルの無効化",
  "orgs.create": "テナント作成（プラットフォーム運用）",
  "orgs.issueAdminCredential": "管理MCP認証発行（プラットフォーム運用）",
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

export type AdminQueueSecretRejection = {
  ok: false;
  code: "secret_detected_in_payload";
  error: "secret_detected_in_payload";
  pattern: string;
  redactedPreview: string;
  messageJa: string;
  nextStepJa: string;
  tool: string;
};

/**
 * Admin policy required rejection.
 * Returned when ADMIN_APPROVER_POLICY_REQUIRED is ON and no admin route policy exists.
 */
export type AdminPolicyRequiredRejection = {
  ok: false;
  code: "admin_policy_required";
  error: "admin_policy_required";
  reason: string;
  messageJa: string;
  nextStepJa: string;
  tool: string;
  auditClass: typeof ADMIN_AUDIT_CLASS;
};

export async function queueAdminTool(input: {
  cred: ResolvedAdminCredential;
  tool: string;
  args: Record<string, unknown>;
  title?: string;
  summary: string;
  jobId?: string;
}): Promise<AdminQueueResult | AdminQueueSecretRejection | AdminPolicyRequiredRejection> {
  // P0-A: Secret-in-chat detector (fail-closed, before approval ticket creation)
  // Chat NEVER: passwords, refresh tokens, API keys, full employee/admin badge secrets
  const secretDetection = detectSecretInPayload(input.args);
  if (!secretDetection.ok) {
    const errorResponse = buildSecretDetectionErrorResponse(secretDetection);
    return {
      ...errorResponse,
      tool: input.tool,
    };
  }

  // P0 Item 1: Admin-class tickets require explicit account-approver policy
  // When ADMIN_APPROVER_POLICY_REQUIRED is ON, check for admin route policy
  if (isAdminApproverPolicyRequired()) {
    const orgPolicy = await getOrgApprovalWorkflowPolicy(input.cred.orgId);
    
    const policyCheck = checkAdminPolicyRequirement(
      { purpose: auditActionForAdminTool(input.tool), tool: input.tool, metadata: { auditClass: ADMIN_AUDIT_CLASS } },
      orgPolicy,
      null
    );

    if (!policyCheck.ok) {
      await appendAuditEvent({
        orgId: input.cred.orgId,
        employeeId: null,
        credentialId: null,
        action: "admin.policy",
        purpose: auditActionForAdminTool(input.tool),
        summary: `管理クラス承認拒否（ポリシー未設定）: ${input.tool}`,
        metadata: {
          tool: input.tool,
          code: policyCheck.code,
          reason: policyCheck.reason,
          auditClass: ADMIN_AUDIT_CLASS,
          flagEnabled: true,
        },
      });

      return {
        ok: false,
        code: "admin_policy_required",
        error: "admin_policy_required",
        reason: policyCheck.reason,
        messageJa:
          "管理クラスの操作には、組織レベルの承認ワークフローポリシー（管理ルート付き）が必要です。",
        nextStepJa:
          "管理者が approvalWorkflow.patch でadminクラスのルートを含むポリシーを設定してください。",
        tool: input.tool,
        auditClass: ADMIN_AUDIT_CLASS,
      };
    }
  }

  const auditAction = auditActionForAdminTool(input.tool);
  const title = input.title || TOOL_TITLE_JA[input.tool] || input.tool;
  const jobId =
    input.jobId ||
    (typeof input.args.jobId === "string" ? input.args.jobId : "") ||
    `admin_${input.tool}_${Date.now().toString(36)}`;
  const requester: AdminRequester = {
    kind: "admin_agent",
    credentialGeneration: input.cred.generation,
    grokBotAgentId: input.cred.grokBotAgentId,
    actorId: input.cred.actorId,
  };
  const created = await createApproval({
    orgId: input.cred.orgId,
    employeeId: "",
    credentialId: "",
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
    credentialId: null,
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
