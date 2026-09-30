import type { ApprovalRequest } from "@/lib/types";
import type { AdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { getRuntimeMemberById } from "@/lib/demo-data";
import { getApprovalById } from "@/lib/data/approvals";
import { getEmployee } from "@/lib/data/employees";
import { appendAuditEvent } from "@/lib/data/audit";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { getNotificationChannelSecretsById, listNotificationChannels } from "@/lib/data/notification-channels";
import { getWorkflowInstanceByApprovalId, getBallotsByInstanceId,
  setEmployeeApprovalWorkflowPolicy, setOrgApprovalWorkflowPolicy } from "./data";
import { normalizeApprovalWorkflowPolicy, validateApprovalWorkflowPolicy } from "./validate";
import {
  regenerateVerificationForBinding,
  getVoterBinding,
  isTelegramGlobalChannelKey,
  type VoterBindingProvider,
} from "./voter-binding";
import {
  sendVerificationToTelegramUser,
  sendVerificationToTelegramUserViaChannel,
  sendVerificationToTelegramGroup,
} from "./telegram-binding-verification";
import { sendVerificationDmToSlackUser } from "./voter-binding-verification";

export async function isCurrentWorkflowMember(orgId: string, memberId: string): Promise<boolean> {
  if (isDemoMode()) {
    const member = getRuntimeMemberById(memberId);
    return !!member && member.orgId === orgId && member.status === "active" && !!member.capabilities?.includes("approve_actions");
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("workflow_unavailable");
  const { data, error } = await admin.rpc("workflow_voter_is_current", { p_org: orgId, p_member: memberId });
  if (error || typeof data !== "boolean") throw new Error("workflow_voter_check_failed");
  return data;
}

/** Called only inside the #80 authority/claim wrapper after human approval. */
export async function fulfillWorkflowMutation(approval: ApprovalRequest, args: Record<string, unknown>, tool: string): Promise<AdminFulfillment> {
  const base = { tool, at: new Date().toISOString() };
  if (tool === "approvalWorkflow.patch") {
    const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
    if (employeeId && !(await getEmployee(employeeId, approval.orgId))) return { ...base, ok: false, error: "employee_not_found" };
    const clear = args.clearOverride === true;
    if (clear && !employeeId) return { ...base, ok: false, error: "clear_requires_employee" };
    if (!clear && !validateApprovalWorkflowPolicy(args).ok) return { ...base, ok: false, error: "workflow_invalid_policy" };
    const policy = clear ? null : normalizeApprovalWorkflowPolicy({ ...args, updatedBy: approval.resolvedBy || "admin_mcp" });
    if (policy) {
      const voters = new Set([...policy.stages.flatMap(s => s.voterUserIds), ...(policy.finalGoUserId ? [policy.finalGoUserId] : [])]);
      for (const memberId of voters) {
        if (!(await isCurrentWorkflowMember(approval.orgId, memberId))) return { ...base, ok: false, error: "voter_not_authorized" };
      }
    }
    const saved = employeeId ? await setEmployeeApprovalWorkflowPolicy(employeeId, approval.orgId, policy)
      : await setOrgApprovalWorkflowPolicy(approval.orgId, policy!);
    if (!saved) return { ...base, ok: false, error: "workflow_policy_write_failed" };
    await appendAuditEvent({ orgId: approval.orgId, employeeId: employeeId || null, credentialId: null,
      action: "admin.policy", purpose: "admin.policy", summary: "承認ワークフローを更新（管理MCP・人承認）",
      metadata: { approvalId: approval.id, employeeId: employeeId || null, policyId: policy?.policyId ?? null, clearOverride: clear } });
    return { ...base, ok: true, summaryJa: clear ? "社員の個別設定を解除しました" : "承認ワークフローを更新しました" };
  }

  const targetId = typeof args.targetApprovalId === "string" ? args.targetApprovalId.trim() : "";
  const target = await getApprovalById(targetId, approval.orgId);
  if (!target || target.status !== "pending") return { ...base, ok: false, error: "target_approval_not_pending" };
  const instance = await getWorkflowInstanceByApprovalId(target.id);
  if (!instance || instance.orgId !== approval.orgId || instance.status !== "active") return { ...base, ok: false, error: "workflow_not_active" };
  const pending = (await getBallotsByInstanceId(instance.id)).filter(b => b.vote === null &&
    (instance.finalGoPending ? b.isFinalGo : !b.isFinalGo && b.stageIndex === instance.currentStageIndex));
  let eligible = 0;
  for (const ballot of pending) if (await isCurrentWorkflowMember(approval.orgId, ballot.voterUserId)) eligible++;
  if (!eligible) return { ...base, ok: false, error: "no_current_pending_voters" };
  const results = await sendApprovalNotifications(target, await getEmployee(target.employeeId, target.orgId));
  const ok = results.some(r => r.ok && !r.skipped);
  return { ...base, ok, ...(ok ? { summaryJa: `承認インボックスへリマインドしました（有効な未投票者 ${eligible} 名）` }
    : { error: "workflow_reminder_delivery_failed" }) };
}

export interface ResendVoterVerificationInput {
  orgId: string;
  provider: VoterBindingProvider;
  channelKey: string;
  externalUserId: string;
}

export interface ResendVoterVerificationResult {
  ok: boolean;
  messageJa: string;
  error?: string;
}

export async function resendVoterVerification(
  input: ResendVoterVerificationInput
): Promise<ResendVoterVerificationResult> {
  const binding = await getVoterBinding(
    input.orgId,
    input.provider,
    input.channelKey,
    input.externalUserId
  );

  if (!binding) {
    return { ok: false, messageJa: "バインディングが見つかりません。", error: "binding_not_found" };
  }

  if (binding.status !== "pending") {
    if (binding.status === "active") {
      return { ok: false, messageJa: "このバインディングは既に検証済みです。", error: "already_verified" };
    }
    if (binding.status === "revoked") {
      return { ok: false, messageJa: "このバインディングは取り消されています。", error: "binding_revoked" };
    }
    if (binding.status === "expired") {
      return { ok: false, messageJa: "このバインディングの有効期限が切れています。", error: "binding_expired" };
    }
    return { ok: false, messageJa: "バインディングの状態が不正です。", error: "invalid_status" };
  }

  const regenResult = await regenerateVerificationForBinding(
    input.orgId,
    input.provider,
    input.channelKey,
    input.externalUserId
  );

  if (!regenResult.ok || !regenResult.verificationCode || !regenResult.verificationNonce) {
    return { ok: false, messageJa: regenResult.messageJa || "検証コードの再生成に失敗しました。", error: regenResult.reason };
  }

  const memberName = `メンバー ${binding.memberId.slice(0, 8)}`;
  const orgName = "Staffpass組織";

  if (input.provider === "slack") {
    const channelSecrets = await getNotificationChannelSecretsById(input.orgId, input.channelKey);
    if (!channelSecrets.botToken) {
      return { ok: false, messageJa: "Slackチャネルのボットトークンが設定されていません。", error: "missing_bot_token" };
    }
    await sendVerificationDmToSlackUser({
      botToken: channelSecrets.botToken,
      slackUserId: input.externalUserId,
      orgId: input.orgId,
      channelKey: input.channelKey,
      memberId: binding.memberId,
      memberDisplayName: memberName,
      orgName,
      verificationCode: regenResult.verificationCode,
    });
    return { ok: true, messageJa: "Slack DMで検証メッセージを再送信しました。" };
  }

  if (input.provider === "telegram" && isTelegramGlobalChannelKey(input.channelKey)) {
    const telegramResult = await sendVerificationToTelegramUser({
      telegramUserId: input.externalUserId,
      orgId: input.orgId,
      memberId: binding.memberId,
      memberDisplayName: memberName,
      orgName,
      verificationCode: regenResult.verificationCode,
      verificationNonce: regenResult.verificationNonce,
      channelKey: input.channelKey,
    });
    if (telegramResult.ok) {
      return { ok: true, messageJa: "Telegram DMで検証メッセージを再送信しました。" };
    }
    return { ok: false, messageJa: `Telegram DMの送信に失敗しました: ${telegramResult.error}`, error: telegramResult.error };
  }

  if (input.provider === "telegram") {
    const channelSecrets = await getNotificationChannelSecretsById(input.orgId, input.channelKey);
    const channels = await listNotificationChannels(input.orgId);
    const channel = channels.find((ch) => ch.id === input.channelKey && ch.provider === "telegram");
    const chatId = String(channel?.config?.chatId || "").trim();
    const isGroupChat = chatId.startsWith("-");

    if (!channelSecrets.botToken) {
      return { ok: false, messageJa: "Telegramチャネルのボットトークンが設定されていません。", error: "missing_bot_token" };
    }

    const telegramResult = await sendVerificationToTelegramUserViaChannel({
      telegramUserId: input.externalUserId,
      orgId: input.orgId,
      memberId: binding.memberId,
      memberDisplayName: memberName,
      orgName,
      verificationCode: regenResult.verificationCode,
      verificationNonce: regenResult.verificationNonce,
      channelId: input.channelKey,
      botToken: channelSecrets.botToken,
    });

    if (telegramResult.ok) {
      return { ok: true, messageJa: "Telegram DMで検証メッセージを再送信しました。" };
    }

    if (telegramResult.error === "bot_blocked_or_not_started" && isGroupChat && chatId) {
      const groupResult = await sendVerificationToTelegramGroup({
        telegramUserId: input.externalUserId,
        orgId: input.orgId,
        memberId: binding.memberId,
        memberDisplayName: memberName,
        orgName,
        verificationCode: regenResult.verificationCode,
        verificationNonce: regenResult.verificationNonce,
        channelId: input.channelKey,
        botToken: channelSecrets.botToken,
        groupChatId: chatId,
      });
      if (groupResult.ok) {
        return { ok: true, messageJa: "グループチャットに検証メッセージを再送信しました。" };
      }
      return { ok: false, messageJa: `グループチャットへの送信に失敗しました: ${groupResult.error}`, error: groupResult.error };
    }

    return {
      ok: false,
      messageJa: telegramResult.nextStepJa || `Telegram DMの送信に失敗しました: ${telegramResult.error}`,
      error: telegramResult.error,
    };
  }

  if (input.provider === "line") {
    return { ok: false, messageJa: "LINEの検証再送信はまだサポートされていません。", error: "line_not_supported" };
  }

  return { ok: false, messageJa: "不明なプロバイダーです。", error: "unknown_provider" };
}
