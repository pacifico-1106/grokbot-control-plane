/**
 * Voter binding registration and identity verification.
 *
 * P0 Item 2: Allow org admins to bind external identities (Slack, Telegram, LINE)
 * to org members for approval workflow voting.
 *
 * Security invariants:
 * - Member must belong to the same org as the channel (cross-org invariant)
 * - External team users rejected (Slack Connect)
 * - Identity verification required before binding becomes active (pending state)
 * - Expiring bindings with configurable TTL
 * - No auto-matching by name/email guesses
 */

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { setDemoWorkflowVoterBinding } from "./data";

function getVoterBindingSecret(): string {
  const secret = process.env.VOTER_BINDING_SECRET;
  if (isDemoMode()) {
    return secret || "dev-secret";
  }
  if (!secret || secret.trim() === "" || secret === "dev-secret") {
    throw new Error("VOTER_BINDING_SECRET must be configured in production");
  }
  return secret;
}

export type VoterBindingProvider = "slack" | "telegram" | "line";
export type VoterBindingStatus = "pending" | "active" | "expired" | "revoked";

export interface VoterBinding {
  orgId: string;
  provider: VoterBindingProvider;
  channelKey: string;
  externalUserId: string;
  memberId: string;
  status: VoterBindingStatus;
  teamId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVoterBindingInput {
  orgId: string;
  provider: VoterBindingProvider;
  channelKey: string;
  externalUserId: string;
  memberId: string;
  teamId?: string;
  expiresInDays?: number;
}

export interface VerifyVoterBindingInput {
  orgId: string;
  provider: VoterBindingProvider;
  channelKey: string;
  externalUserId: string;
  verificationCode?: string;
  teamId?: string;
}

export interface ListVoterBindingsInput {
  orgId: string;
  provider?: VoterBindingProvider;
  channelKey?: string;
  memberId?: string;
  includeExpired?: boolean;
  includeRevoked?: boolean;
}

const DEFAULT_EXPIRY_DAYS = 180;
const VERIFICATION_CODE_LENGTH = 6;
const VERIFICATION_CODE_EXPIRY_MS = 15 * 60 * 1000;

type DemoBinding = VoterBinding & { verificationCode?: string; verificationExpiry?: number; failedVerificationAttempts?: number };
const demoBindings = new Map<string, DemoBinding>();
const bindingKey = (b: Pick<VoterBinding, "orgId" | "provider" | "channelKey" | "externalUserId">) =>
  JSON.stringify([b.orgId, b.provider, b.channelKey, b.externalUserId]);

function computeEffectiveStatus(binding: VoterBinding): VoterBindingStatus {
  if (binding.revokedAt) return "revoked";
  if (!binding.verifiedAt) return "pending";
  if (binding.expiresAt && new Date(binding.expiresAt) < new Date()) return "expired";
  return "active";
}

export function generateVerificationCode(): string {
  const bytes = randomBytes(4);
  const num = bytes.readUInt32BE(0) % 1000000;
  return num.toString().padStart(VERIFICATION_CODE_LENGTH, "0");
}

export function hashVerificationCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code).digest("hex");
}

export async function checkMemberBelongsToOrg(
  memberId: string,
  orgId: string
): Promise<{ ok: boolean; reason?: string }> {
  if (isDemoMode()) {
    const { getRuntimeMemberById } = await import("@/lib/demo-data");
    const member = getRuntimeMemberById(memberId);
    if (!member) return { ok: false, reason: "member_not_found" };
    if (member.orgId !== orgId) return { ok: false, reason: "cross_org_member" };
    if (member.status !== "active") return { ok: false, reason: "member_not_active" };
    return { ok: true };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "supabase_unavailable" };

  const { data, error } = await admin
    .from("org_members")
    .select("id, org_id, status")
    .eq("id", memberId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "member_not_found" };
  if (data.status !== "active") return { ok: false, reason: "member_not_active" };
  return { ok: true };
}

/**
 * Reserved channelKey for the global Telegram approval route.
 * This is not an org_notification_channels UUID, but a special key
 * that maps to the env-based TELEGRAM_BOT_TOKEN / TELEGRAM_APPROVAL_CHAT_ID route.
 */
export const TELEGRAM_GLOBAL_CHANNEL_KEY = "telegram:global";

export function isTelegramGlobalChannelKey(channelKey: string): boolean {
  return channelKey === TELEGRAM_GLOBAL_CHANNEL_KEY;
}

export async function checkChannelBelongsToOrg(
  channelKey: string,
  orgId: string,
  provider: VoterBindingProvider
): Promise<{ ok: boolean; teamId?: string; reason?: string }> {
  if (isDemoMode()) {
    return { ok: true };
  }

  if (provider === "telegram" && isTelegramGlobalChannelKey(channelKey)) {
    return { ok: true };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "supabase_unavailable" };

  const { data, error } = await admin
    .from("org_notification_channels")
    .select("id, org_id, provider, config")
    .eq("id", channelKey)
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "channel_not_found" };

  const config = data.config as Record<string, unknown> | null;
  const expectedTeamId = config?.expectedTeamId as string | undefined;
  
  return { ok: true, teamId: expectedTeamId };
}

export async function createPendingVoterBinding(
  input: CreateVoterBindingInput
): Promise<{ ok: true; binding: VoterBinding; verificationCode: string } | { ok: false; reason: string; messageJa: string }> {
  const memberCheck = await checkMemberBelongsToOrg(input.memberId, input.orgId);
  if (!memberCheck.ok) {
    return {
      ok: false,
      reason: memberCheck.reason || "cross_org_invariant_violated",
      messageJa: memberCheck.reason === "member_not_found"
        ? "指定されたメンバーが見つかりません。"
        : memberCheck.reason === "member_not_active"
          ? "指定されたメンバーは無効化されています。"
          : "メンバーはこの組織に所属していません（クロスオルグ違反）。",
    };
  }

  const channelCheck = await checkChannelBelongsToOrg(input.channelKey, input.orgId, input.provider);
  if (!channelCheck.ok) {
    return {
      ok: false,
      reason: channelCheck.reason || "channel_not_in_org",
      messageJa: "指定された通知チャンネルはこの組織に属していません。",
    };
  }

  if (input.provider === "slack" && channelCheck.teamId && input.teamId && channelCheck.teamId !== input.teamId) {
    return {
      ok: false,
      reason: "external_team_user",
      messageJa: "外部ワークスペースのユーザーはバインドできません（Slack Connect）。",
    };
  }

  const expiresInDays = input.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
  const verificationCode = generateVerificationCode();

  if (isDemoMode()) {
    const binding: DemoBinding = {
      orgId: input.orgId,
      provider: input.provider,
      channelKey: input.channelKey,
      externalUserId: input.externalUserId,
      memberId: input.memberId,
      status: "pending",
      teamId: input.teamId ?? channelCheck.teamId ?? null,
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
      verifiedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      verificationCode,
      verificationExpiry: Date.now() + VERIFICATION_CODE_EXPIRY_MS,
      failedVerificationAttempts: 0,
    };
    demoBindings.set(bindingKey(binding), binding);
    return { ok: true, binding, verificationCode };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, reason: "supabase_unavailable", messageJa: "データベースに接続できません。" };
  }

  const verificationHash = hashVerificationCode(verificationCode, getVoterBindingSecret());
  const verificationExpiry = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MS);

  const { data, error } = await admin
    .from("approval_workflow_voter_bindings")
    .upsert(
      {
        org_id: input.orgId,
        provider: input.provider,
        channel_key: input.channelKey,
        external_user_id: input.externalUserId,
        member_id: input.memberId,
        team_id: input.teamId ?? channelCheck.teamId ?? null,
        expires_at: expiresAt.toISOString(),
        revoked_at: null,
        verified_at: null,
        verification_hash: verificationHash,
        verification_expiry: verificationExpiry.toISOString(),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        failed_verification_attempts: 0,
      },
      { onConflict: "org_id,provider,channel_key,external_user_id" }
    )
    .select("*")
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: "binding_create_failed", messageJa: "バインディングの作成に失敗しました。" };
  }

  const binding = mapBindingRow(data as Record<string, unknown>);
  return { ok: true, binding, verificationCode };
}

export async function verifyVoterBinding(
  input: VerifyVoterBindingInput
): Promise<{ ok: true; binding: VoterBinding } | { ok: false; reason: string; messageJa: string }> {
  const key = bindingKey(input);

  if (isDemoMode()) {
    const demo = demoBindings.get(key);
    if (!demo) {
      return { ok: false, reason: "binding_not_found", messageJa: "バインディングが見つかりません。" };
    }
    if (demo.verifiedAt) {
      return { ok: false, reason: "already_verified", messageJa: "このバインディングは既に検証済みです。" };
    }
    if (demo.revokedAt) {
      return { ok: false, reason: "binding_revoked", messageJa: "このバインディングは取り消されています。" };
    }
    const MAX_DEMO_FAILED_ATTEMPTS = 5;
    const demoFailedAttempts = demo.failedVerificationAttempts ?? 0;
    if (demoFailedAttempts >= MAX_DEMO_FAILED_ATTEMPTS) {
      return { ok: false, reason: "verification_locked", messageJa: "検証試行回数の上限に達しました。管理者に連絡してください。" };
    }
    if (!demo.verificationCode || !demo.verificationExpiry) {
      return { ok: false, reason: "no_pending_verification", messageJa: "保留中の検証がありません。" };
    }
    if (Date.now() > demo.verificationExpiry) {
      return { ok: false, reason: "verification_expired", messageJa: "検証コードの有効期限が切れています。" };
    }
    if (input.verificationCode !== demo.verificationCode) {
      demo.failedVerificationAttempts = demoFailedAttempts + 1;
      demo.updatedAt = new Date().toISOString();
      if (demo.failedVerificationAttempts >= MAX_DEMO_FAILED_ATTEMPTS) {
        delete demo.verificationCode;
        delete demo.verificationExpiry;
      }
      demoBindings.set(key, demo);
      if (demo.failedVerificationAttempts >= MAX_DEMO_FAILED_ATTEMPTS) {
        return { ok: false, reason: "verification_locked", messageJa: "検証試行回数の上限に達しました。管理者に連絡してください。" };
      }
      return { ok: false, reason: "invalid_verification_code", messageJa: "検証コードが一致しません。" };
    }
    if (demo.teamId && !input.teamId) {
      return { ok: false, reason: "team_id_required", messageJa: "ワークスペースIDが必要です。" };
    }
    if (demo.teamId && input.teamId !== demo.teamId) {
      return { ok: false, reason: "team_id_mismatch", messageJa: "ワークスペースIDが一致しません（外部ユーザー拒否）。" };
    }

    const now = new Date().toISOString();
    demo.verifiedAt = now;
    demo.updatedAt = now;
    demo.status = "active";
    demo.teamId = input.teamId ?? demo.teamId;
    delete demo.verificationCode;
    delete demo.verificationExpiry;
    demoBindings.set(key, demo);

    setDemoWorkflowVoterBinding({
      orgId: demo.orgId,
      provider: demo.provider,
      channelKey: demo.channelKey,
      userId: demo.externalUserId,
      memberId: demo.memberId,
      expiresAt: demo.expiresAt ?? undefined,
      verifiedAt: demo.verifiedAt,
    });

    return { ok: true, binding: demo };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, reason: "supabase_unavailable", messageJa: "データベースに接続できません。" };
  }

  const { data: existing, error: fetchError } = await admin
    .from("approval_workflow_voter_bindings")
    .select("*")
    .eq("org_id", input.orgId)
    .eq("provider", input.provider)
    .eq("channel_key", input.channelKey)
    .eq("external_user_id", input.externalUserId)
    .maybeSingle();

  if (fetchError || !existing) {
    return { ok: false, reason: "binding_not_found", messageJa: "バインディングが見つかりません。" };
  }

  const row = existing as Record<string, unknown>;
  if (row.verified_at) {
    return { ok: false, reason: "already_verified", messageJa: "このバインディングは既に検証済みです。" };
  }
  if (row.revoked_at) {
    return { ok: false, reason: "binding_revoked", messageJa: "このバインディングは取り消されています。" };
  }

  const MAX_FAILED_ATTEMPTS = 5;
  const failedAttempts = Number(row.failed_verification_attempts ?? 0);
  if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: "verification_locked", messageJa: "検証試行回数の上限に達しました。管理者に連絡してください。" };
  }

  const verificationExpiry = row.verification_expiry ? new Date(String(row.verification_expiry)) : null;
  if (!verificationExpiry || verificationExpiry < new Date()) {
    return { ok: false, reason: "verification_expired", messageJa: "検証コードの有効期限が切れています。" };
  }

  const expectedHash = row.verification_hash as string;
  const actualHash = hashVerificationCode(
    input.verificationCode || "",
    getVoterBindingSecret()
  );
  const expectedBuf = Buffer.from(expectedHash);
  const actualBuf = Buffer.from(actualHash);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    const newAttempts = failedAttempts + 1;
    const invalidateOnLock = newAttempts >= MAX_FAILED_ATTEMPTS;
    await admin
      .from("approval_workflow_voter_bindings")
      .update({
        failed_verification_attempts: newAttempts,
        updated_at: new Date().toISOString(),
        ...(invalidateOnLock ? { verification_hash: null, verification_expiry: null } : {}),
      })
      .eq("org_id", input.orgId)
      .eq("provider", input.provider)
      .eq("channel_key", input.channelKey)
      .eq("external_user_id", input.externalUserId);

    if (invalidateOnLock) {
      console.warn("voter_binding_verification_locked", {
        orgId: input.orgId,
        provider: input.provider,
        channelKey: input.channelKey,
        externalUserId: input.externalUserId,
      });
      return { ok: false, reason: "verification_locked", messageJa: "検証試行回数の上限に達しました。管理者に連絡してください。" };
    }
    return { ok: false, reason: "invalid_verification_code", messageJa: "検証コードが一致しません。" };
  }

  const existingTeamId = row.team_id as string | null;
  if (existingTeamId && !input.teamId) {
    return { ok: false, reason: "team_id_required", messageJa: "ワークスペースIDが必要です。" };
  }
  if (existingTeamId && input.teamId !== existingTeamId) {
    return { ok: false, reason: "team_id_mismatch", messageJa: "ワークスペースIDが一致しません（外部ユーザー拒否）。" };
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await admin
    .from("approval_workflow_voter_bindings")
    .update({
      verified_at: now,
      updated_at: now,
      team_id: input.teamId ?? existingTeamId,
      verification_hash: null,
      verification_expiry: null,
    })
    .eq("org_id", input.orgId)
    .eq("provider", input.provider)
    .eq("channel_key", input.channelKey)
    .eq("external_user_id", input.externalUserId)
    .is("verified_at", null)
    .is("revoked_at", null)
    .eq("verification_hash", expectedHash)
    .gt("verification_expiry", new Date().toISOString())
    .select("*")
    .maybeSingle();

  if (updateError) {
    return { ok: false, reason: "verification_update_failed", messageJa: "検証の更新に失敗しました。" };
  }

  if (!updated) {
    return { ok: false, reason: "verification_race_or_expired", messageJa: "検証が既に完了しているか、有効期限が切れています。" };
  }

  return { ok: true, binding: mapBindingRow(updated as Record<string, unknown>) };
}

export async function revokeVoterBinding(
  orgId: string,
  provider: VoterBindingProvider,
  channelKey: string,
  externalUserId: string
): Promise<{ ok: true } | { ok: false; reason: string; messageJa: string }> {
  const key = bindingKey({ orgId, provider, channelKey, externalUserId });

  if (isDemoMode()) {
    const demo = demoBindings.get(key);
    if (!demo) {
      return { ok: false, reason: "binding_not_found", messageJa: "バインディングが見つかりません。" };
    }
    demo.revokedAt = new Date().toISOString();
    demo.updatedAt = demo.revokedAt;
    demo.status = "revoked";
    demoBindings.set(key, demo);
    return { ok: true };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, reason: "supabase_unavailable", messageJa: "データベースに接続できません。" };
  }

  const now = new Date().toISOString();
  const { error } = await admin
    .from("approval_workflow_voter_bindings")
    .update({ revoked_at: now, updated_at: now })
    .eq("org_id", orgId)
    .eq("provider", provider)
    .eq("channel_key", channelKey)
    .eq("external_user_id", externalUserId);

  if (error) {
    return { ok: false, reason: "revoke_failed", messageJa: "バインディングの取り消しに失敗しました。" };
  }

  return { ok: true };
}

export async function listVoterBindings(
  input: ListVoterBindingsInput
): Promise<VoterBinding[]> {
  if (isDemoMode()) {
    return Array.from(demoBindings.values())
      .filter((b) => {
        if (b.orgId !== input.orgId) return false;
        if (input.provider && b.provider !== input.provider) return false;
        if (input.channelKey && b.channelKey !== input.channelKey) return false;
        if (input.memberId && b.memberId !== input.memberId) return false;
        const status = computeEffectiveStatus(b);
        if (!input.includeExpired && status === "expired") return false;
        if (!input.includeRevoked && status === "revoked") return false;
        return true;
      })
      .map((b) => ({ ...b, status: computeEffectiveStatus(b) }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  let query = admin
    .from("approval_workflow_voter_bindings")
    .select("*")
    .eq("org_id", input.orgId);

  if (input.provider) query = query.eq("provider", input.provider);
  if (input.channelKey) query = query.eq("channel_key", input.channelKey);
  if (input.memberId) query = query.eq("member_id", input.memberId);
  if (!input.includeRevoked) query = query.is("revoked_at", null);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error || !data) return [];

  return data
    .map((row) => mapBindingRow(row as Record<string, unknown>))
    .filter((b) => {
      if (!input.includeExpired && computeEffectiveStatus(b) === "expired") return false;
      return true;
    })
    .map((b) => ({ ...b, status: computeEffectiveStatus(b) }));
}

export async function getVoterBinding(
  orgId: string,
  provider: VoterBindingProvider,
  channelKey: string,
  externalUserId: string
): Promise<VoterBinding | null> {
  const key = bindingKey({ orgId, provider, channelKey, externalUserId });

  if (isDemoMode()) {
    const demo = demoBindings.get(key);
    if (!demo) return null;
    return { ...demo, status: computeEffectiveStatus(demo) };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("approval_workflow_voter_bindings")
    .select("*")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .eq("channel_key", channelKey)
    .eq("external_user_id", externalUserId)
    .maybeSingle();

  if (error || !data) return null;

  const binding = mapBindingRow(data as Record<string, unknown>);
  return { ...binding, status: computeEffectiveStatus(binding) };
}

function mapBindingRow(row: Record<string, unknown>): VoterBinding {
  const binding: VoterBinding = {
    orgId: String(row.org_id || ""),
    provider: String(row.provider || "slack") as VoterBindingProvider,
    channelKey: String(row.channel_key || ""),
    externalUserId: String(row.external_user_id || ""),
    memberId: String(row.member_id || ""),
    status: "pending",
    teamId: row.team_id ? String(row.team_id) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    verifiedAt: row.verified_at ? String(row.verified_at) : null,
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
  binding.status = computeEffectiveStatus(binding);
  return binding;
}

export function resetDemoVoterBindings(): void {
  demoBindings.clear();
}

export async function checkSetupApproverBindingStatus(
  orgId: string
): Promise<{
  hasPendingBindings: boolean;
  hasActiveBindings: boolean;
  pendingCount: number;
  activeCount: number;
  totalCount: number;
  messageJa: string;
  nextStepJa: string;
}> {
  const bindings = await listVoterBindings({ orgId, includeExpired: false, includeRevoked: false });
  const pending = bindings.filter((b) => b.status === "pending");
  const active = bindings.filter((b) => b.status === "active");

  const hasPendingBindings = pending.length > 0;
  const hasActiveBindings = active.length > 0;

  let messageJa: string;
  let nextStepJa: string;

  if (active.length === 0 && pending.length === 0) {
    messageJa = "承認者バインディングが設定されていません。";
    nextStepJa = "approvalWorkflow.bindVoter で Slack/LINE/Telegram ユーザーを組織メンバーに紐付けてください。";
  } else if (pending.length > 0 && active.length === 0) {
    messageJa = `${pending.length} 件のバインディングが検証待ちです。`;
    nextStepJa = "Slack DM で送信された検証コードを確認し、ボタンをクリックして検証を完了してください。";
  } else if (active.length > 0) {
    messageJa = `${active.length} 件のアクティブなバインディングがあります。`;
    nextStepJa = pending.length > 0
      ? `残り ${pending.length} 件のバインディングの検証を完了してください。`
      : "承認者設定は完了しています。smoke テストに進んでください。";
  } else {
    messageJa = "承認者バインディングの状態を確認してください。";
    nextStepJa = "approvalWorkflow.listVoterBindings で現在の設定を確認してください。";
  }

  return {
    hasPendingBindings,
    hasActiveBindings,
    pendingCount: pending.length,
    activeCount: active.length,
    totalCount: bindings.length,
    messageJa,
    nextStepJa,
  };
}
