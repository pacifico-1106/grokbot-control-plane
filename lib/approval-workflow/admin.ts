import { createHmac } from "node:crypto";
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

const RESEND_MIN_INTERVAL_MS = 2 * 60 * 1000;
const RESEND_MAX_PER_24H = 10;
const RESEND_24H_MS = 24 * 60 * 60 * 1000;

function hashExternalUserId(externalUserId: string): string {
  return createHmac("sha256", "resend-audit-salt")
    .update(externalUserId)
    .digest("hex")
    .slice(0, 16);
}

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
  actorCredentialId?: string;
}

export interface ResendVoterVerificationResult {
  ok: boolean;
  messageJa: string;
  error?: string;
}

interface ResendRateLimitInfo {
  lastResendAt: Date | null;
  resendCount24h: number;
  failedVerificationAttempts: number;
}

async function getResendRateLimitInfo(
  orgId: string,
  provider: VoterBindingProvider,
  channelKey: string,
  externalUserId: string
): Promise<ResendRateLimitInfo | null> {
  if (isDemoMode()) {
    return { lastResendAt: null, resendCount24h: 0, failedVerificationAttempts: 0 };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("approval_workflow_voter_bindings")
    .select("last_resend_at, resend_count_24h, failed_verification_attempts")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .eq("channel_key", channelKey)
    .eq("external_user_id", externalUserId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    lastResendAt: data.last_resend_at ? new Date(data.last_resend_at) : null,
    resendCount24h: Number(data.resend_count_24h ?? 0),
    failedVerificationAttempts: Number(data.failed_verification_attempts ?? 0),
  };
}

async function updateResendRateLimit(
  orgId: string,
  provider: VoterBindingProvider,
  channelKey: string,
  externalUserId: string,
  wasLocked: boolean
): Promise<void> {
  if (isDemoMode()) return;

  const admin = createSupabaseAdminClient();
  if (!admin) return;

  const now = new Date();
  const { data: current } = await admin
    .from("approval_workflow_voter_bindings")
    .select("last_resend_at, resend_count_24h")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .eq("channel_key", channelKey)
    .eq("external_user_id", externalUserId)
    .maybeSingle();

  let newCount = 1;
  if (current?.last_resend_at) {
    const lastResend = new Date(current.last_resend_at);
    if (now.getTime() - lastResend.getTime() < RESEND_24H_MS) {
      newCount = (current.resend_count_24h ?? 0) + 1;
    }
  }

  const updateData: Record<string, unknown> = {
    last_resend_at: now.toISOString(),
    resend_count_24h: newCount,
    updated_at: now.toISOString(),
  };

  if (wasLocked) {
    updateData.failed_verification_attempts = 0;
  }

  await admin
    .from("approval_workflow_voter_bindings")
    .update(updateData)
    .eq("org_id", orgId)
    .eq("provider", provider)
    .eq("channel_key", channelKey)
    .eq("external_user_id", externalUserId);
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

  const rateLimitInfo = await getResendRateLimitInfo(
    input.orgId,
    input.provider,
    input.channelKey,
    input.externalUserId
  );

  const wasLocked = rateLimitInfo && rateLimitInfo.failedVerificationAttempts >= 5;

  if (rateLimitInfo && !wasLocked) {
    const now = Date.now();
    if (rateLimitInfo.lastResendAt && now - rateLimitInfo.lastResendAt.getTime() < RESEND_MIN_INTERVAL_MS) {
      const waitSec = Math.ceil((RESEND_MIN_INTERVAL_MS - (now - rateLimitInfo.lastResendAt.getTime())) / 1000);
      await appendAuditEvent({
        orgId: input.orgId,
        employeeId: null,
        credentialId: input.actorCredentialId || null,
        action: "voter_binding.resend_rate_limited",
        purpose: "voter_binding.resend",
        summary: `再送信のレート制限（${waitSec}秒待機が必要）`,
        metadata: {
          provider: input.provider,
          channelKey: input.channelKey,
          externalUserIdHash: hashExternalUserId(input.externalUserId),
          reason: "min_interval",
        },
      });
      return {
        ok: false,
        messageJa: `再送信は2分間隔で制限されています。${waitSec}秒後に再試行してください。`,
        error: "rate_limited_min_interval",
      };
    }

    if (rateLimitInfo.lastResendAt && now - rateLimitInfo.lastResendAt.getTime() < RESEND_24H_MS) {
      if (rateLimitInfo.resendCount24h >= RESEND_MAX_PER_24H) {
        await appendAuditEvent({
          orgId: input.orgId,
          employeeId: null,
          credentialId: input.actorCredentialId || null,
          action: "voter_binding.resend_rate_limited",
          purpose: "voter_binding.resend",
          summary: `再送信の24時間上限に達しました（${RESEND_MAX_PER_24H}回）`,
          metadata: {
            provider: input.provider,
            channelKey: input.channelKey,
            externalUserIdHash: hashExternalUserId(input.externalUserId),
            reason: "max_24h",
          },
        });
        return {
          ok: false,
          messageJa: `24時間以内の再送信上限（${RESEND_MAX_PER_24H}回）に達しました。`,
          error: "rate_limited_max_24h",
        };
      }
    }
  }

  const regenResult = await regenerateVerificationForBinding(
    input.orgId,
    input.provider,
    input.channelKey,
    input.externalUserId
  );

  if (!regenResult.ok || !regenResult.verificationCode || !regenResult.verificationNonce) {
    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: null,
      credentialId: input.actorCredentialId || null,
      action: "voter_binding.resend_failed",
      purpose: "voter_binding.resend",
      summary: `検証再生成に失敗: ${regenResult.reason}`,
      metadata: {
        provider: input.provider,
        channelKey: input.channelKey,
        externalUserIdHash: hashExternalUserId(input.externalUserId),
        reason: regenResult.reason,
      },
    });
    return { ok: false, messageJa: regenResult.messageJa || "検証コードの再生成に失敗しました。", error: regenResult.reason };
  }

  const memberName = `メンバー ${binding.memberId.slice(0, 8)}`;
  const orgName = "Staffpass組織";

  let sendResult: { ok: boolean; messageJa: string; error?: string };

  if (input.provider === "slack") {
    const channelSecrets = await getNotificationChannelSecretsById(input.orgId, input.channelKey);
    if (!channelSecrets.botToken) {
      sendResult = { ok: false, messageJa: "Slackチャネルのボットトークンが設定されていません。", error: "missing_bot_token" };
    } else {
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
      sendResult = { ok: true, messageJa: "Slack DMで検証メッセージを再送信しました。" };
    }
  } else if (input.provider === "telegram" && isTelegramGlobalChannelKey(input.channelKey)) {
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
      sendResult = { ok: true, messageJa: "Telegram DMで検証メッセージを再送信しました。" };
    } else {
      sendResult = { ok: false, messageJa: `Telegram DMの送信に失敗しました: ${telegramResult.error}`, error: telegramResult.error };
    }
  } else if (input.provider === "telegram") {
    const channelSecrets = await getNotificationChannelSecretsById(input.orgId, input.channelKey);
    const channels = await listNotificationChannels(input.orgId);
    const channel = channels.find((ch) => ch.id === input.channelKey && ch.provider === "telegram");
    const chatId = String(channel?.config?.chatId || "").trim();
    const isGroupChat = chatId.startsWith("-");

    if (!channelSecrets.botToken) {
      sendResult = { ok: false, messageJa: "Telegramチャネルのボットトークンが設定されていません。", error: "missing_bot_token" };
    } else {
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
        chatId,
      });

      if (telegramResult.ok) {
        sendResult = { ok: true, messageJa: isGroupChat ? "グループチャットに検証メッセージを再送信しました。" : "Telegramチャットに検証メッセージを再送信しました。" };
      } else if (telegramResult.error === "chat_not_reachable" && isGroupChat && chatId) {
        sendResult = {
          ok: false,
          messageJa: telegramResult.nextStepJa || `グループチャットに送信できません。Botがグループに追加されているか確認してください。`,
          error: telegramResult.error,
        };
      } else {
        sendResult = {
          ok: false,
          messageJa: telegramResult.nextStepJa || `Telegramへの送信に失敗しました: ${telegramResult.error}`,
          error: telegramResult.error,
        };
      }
    }
  } else if (input.provider === "line") {
    sendResult = { ok: false, messageJa: "LINEの検証再送信はまだサポートされていません。", error: "line_not_supported" };
  } else {
    sendResult = { ok: false, messageJa: "不明なプロバイダーです。", error: "unknown_provider" };
  }

  if (sendResult.ok) {
    await updateResendRateLimit(
      input.orgId,
      input.provider,
      input.channelKey,
      input.externalUserId,
      wasLocked ?? false
    );

    if (wasLocked) {
      await appendAuditEvent({
        orgId: input.orgId,
        employeeId: null,
        credentialId: input.actorCredentialId || null,
        action: "voter_binding.unlock_via_resend",
        purpose: "voter_binding.resend",
        summary: "ロックされたバインディングを再送信でアンロック",
        metadata: {
          provider: input.provider,
          channelKey: input.channelKey,
          externalUserIdHash: hashExternalUserId(input.externalUserId),
        },
      });
    }
  }

  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: null,
    credentialId: input.actorCredentialId || null,
    action: sendResult.ok ? "voter_binding.resend_success" : "voter_binding.resend_failed",
    purpose: "voter_binding.resend",
    summary: sendResult.ok ? "検証メッセージを再送信" : `再送信に失敗: ${sendResult.error}`,
    metadata: {
      provider: input.provider,
      channelKey: input.channelKey,
      externalUserIdHash: hashExternalUserId(input.externalUserId),
      outcome: sendResult.ok ? "success" : "failure",
      ...(sendResult.error ? { error: sendResult.error } : {}),
    },
  });

  return sendResult;
}
