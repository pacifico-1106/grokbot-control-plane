/**
 * Always-human queue for admin MCP tools.
 * Create an approval ticket; do not mutate until a different human approves.
 * 
 * P0-A: Secret-in-chat detector integrated (fail-closed).
 * Secrets detected in args are rejected before approval ticket creation.
 *
 * P0 Item 1: Admin-class tickets require explicit account-approver policy
 * when ADMIN_APPROVER_POLICY_REQUIRED flag is enabled.
 * Default admin approver = org owner(s). If no explicit route and no org owners, fail-closed.
 */
import { sendApprovalNeededEmail } from "@/lib/email";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { appendAuditEvent, createApproval } from "@/lib/data";
import { getOrgOwnerIds } from "@/lib/data/members";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { auditActionForAdminTool, ADMIN_AUDIT_CLASS, isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
export { isAdminClassApproval };
import type { AdminRequester } from "@/lib/admin-mcp/self-approval";
import {
  detectSecretInPayload,
  buildSecretDetectionErrorResponse,
} from "@/lib/security/secret-detector";
import {
  auditSecretDetectionBlocked,
  auditSecretDetectionSuspected,
  safeEcho,
} from "@/lib/security/secret-detection-audit";
import { checkAdminPolicyRequirement } from "@/lib/approval-workflow/admin-policy";
import { getOrgApprovalWorkflowPolicy } from "@/lib/approval-workflow/data";
import { isAdminApproverPolicyRequired } from "@/lib/feature-flags";
import { approverFilingStop } from "@/lib/approver-authority/filing";

export const ADMIN_TOOL_TITLE_JA: Record<string, string> = {
  "employees.issue": "AI社員の発行",
  link: "AI社員の連携",
  "policy.patch": "権限の更新",
  "parties.upsert": "相手台帳の更新",
  "channels.classify": "チャネル分類",
  "channels.list": "チャネル分類台帳の一覧（読み取り）",
  "parties.list": "相手台帳の一覧（読み取り）",
  "roles.propose": "職務案の提案",
  "ingressHandoff.patch": "受信の渡し方",
  "setup.slackAdapter.setBotToken": "Slack会話投稿Botトークン",
  "setup.lineApproval.upsert": "承認用LINEチャネル",
  "setup.lineApproval.setEmployeeInbox": "AI社員の承認インボックス（LINE）",
  "setup.lineApproval.demoteTelegram": "Telegram承認チャネルの無効化",
  "approvalWorkflow.bindVoter": "承認者バインディング作成",
  "approvalWorkflow.unbindVoter": "承認者バインディング取り消し",
  "orgs.create": "テナント作成（プラットフォーム運用）",
  "orgs.issueAdminCredential": "管理MCP認証発行（プラットフォーム運用）",
  "channels.remove": "チャネル台帳から削除",
  "parties.remove": "相手台帳から削除",
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
  /** Constant; never characters of the value. */
  redactedPreview: string;
  fieldPath: string;
  matchLength: number;
  messageJa: string;
  nextStepJa: string;
  nextStep: string;
  retryable: false;
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

/**
 * PR-D (APPROVER_AUTHORITY_ENABLED): nobody other than the requester could
 * approve the ticket (zero owners / every owner is the requester).
 */
export type ApproverAuthorityFilingRejection = {
  ok: false;
  code: "org_has_no_owner" | "no_owner_other_than_requester";
  error: "org_has_no_owner" | "no_owner_other_than_requester";
  reason: "org_has_no_owner" | "no_owner_other_than_requester";
  messageJa: string;
  nextStepJa: string;
  tool: string;
  auditClass: typeof ADMIN_AUDIT_CLASS;
};

export async function queueAdminTool(input: {
  cred: ResolvedAdminCredential;
  tool: string;
  args: Record<string, unknown>;
  /** Raw user input for secret scanning (before encryption). If omitted, args is scanned. */
  rawArgsForSecretScan?: Record<string, unknown>;
  title?: string;
  summary: string;
  jobId?: string;
}): Promise<AdminQueueResult | AdminQueueSecretRejection | AdminPolicyRequiredRejection | ApproverAuthorityFilingRejection> {
  // P0-A: Secret-in-chat detector (fail-closed, before approval ticket creation)
  // Chat NEVER: passwords, refresh tokens, API keys, full employee/admin badge secrets
  // IMPORTANT: Scan raw user input (rawArgsForSecretScan), NOT the post-encryption args.
  // Server-generated ciphertext (*Ciphertext fields from lib/notify/crypto) must not trigger.
  const argsToScan = input.rawArgsForSecretScan ?? input.args;
  // 2026-10-05: one secret_detection.blocked row per rejection (credential org,
  // no value); a failed write still rejects.
  const secretDetection = detectSecretInPayload(argsToScan);
  if (!secretDetection.ok || secretDetection.suspected) {
    const scope = {
      orgId: input.cred.orgId || null,
      employeeId: null,
      credentialId: null,
      surface: "admin_queue" as const,
      tool: input.tool,
      jobId: input.jobId ?? null,
    };
    if (!secretDetection.ok) {
      await auditSecretDetectionBlocked(scope, secretDetection);
      const errorResponse = buildSecretDetectionErrorResponse(secretDetection);
      return {
        ...errorResponse,
        tool: safeEcho(input.tool) ?? input.tool,
      };
    }
    await auditSecretDetectionSuspected(scope, secretDetection.suspected ?? []);
  }

  // P0 Item 1: Admin-class tickets require explicit account-approver policy
  // When ADMIN_APPROVER_POLICY_REQUIRED is ON, check for admin route policy or org owners
  if (isAdminApproverPolicyRequired()) {
    const orgPolicy = await getOrgApprovalWorkflowPolicy(input.cred.orgId);
    const orgOwnerIds = await getOrgOwnerIds(input.cred.orgId);
    
    const policyCheck = checkAdminPolicyRequirement(
      {
        purpose: auditActionForAdminTool(input.tool),
        tool: input.tool,
        metadata: { auditClass: ADMIN_AUDIT_CLASS, isAdminMcpTool: true },
      },
      orgPolicy,
      null,
      orgOwnerIds
    );

    if (!policyCheck.ok) {
      await appendAuditEvent({
        orgId: input.cred.orgId,
        employeeId: null,
        credentialId: null,
        action: "admin.policy",
        purpose: auditActionForAdminTool(input.tool),
        summary: `管理クラス承認拒否（承認者未設定）: ${input.tool}`,
        metadata: {
          tool: input.tool,
          code: policyCheck.code,
          reason: policyCheck.reason,
          auditClass: ADMIN_AUDIT_CLASS,
          flagEnabled: true,
          orgOwnerCount: orgOwnerIds.length,
        },
      });

      return {
        ok: false,
        code: "admin_policy_required",
        error: "admin_policy_required",
        reason: policyCheck.reason,
        messageJa:
          "管理クラスの操作には、組織レベルの承認者設定（管理ルートまたは組織オーナー）が必要です。",
        nextStepJa:
          "組織にオーナーを追加するか、approvalWorkflow.patch でadminクラスのルートを設定してください。",
        tool: input.tool,
        auditClass: ADMIN_AUDIT_CLASS,
      };
    }
  }

  const auditAction = auditActionForAdminTool(input.tool);
  const title = input.title || ADMIN_TOOL_TITLE_JA[input.tool] || input.tool;
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
  // PR-D: nobody other than the requester could approve → stop with a nextStep.
  const authorityStop = await approverFilingStop({
    orgId: input.cred.orgId,
    tool: input.tool,
    metadata: { adminMutation: input.args, adminRequester: requester },
  });
  if (authorityStop) {
    await appendAuditEvent({
      orgId: input.cred.orgId,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: auditAction,
      summary: `承認者権限により申請を停止: ${input.tool}`,
      metadata: {
        tool: input.tool,
        code: authorityStop.reason,
        requiredApproverKind: authorityStop.requiredApproverKind,
        auditClass: ADMIN_AUDIT_CLASS,
      },
    });
    return {
      ok: false,
      code: authorityStop.reason,
      error: authorityStop.reason,
      reason: authorityStop.reason,
      messageJa: authorityStop.messageJa,
      nextStepJa: authorityStop.nextStepJa,
      tool: input.tool,
      auditClass: ADMIN_AUDIT_CLASS,
    };
  }
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
      approvalClass: ADMIN_AUDIT_CLASS,
      auditAction,
      always_human: true,
      adminTool: input.tool,
      isAdminMcpTool: true,
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
