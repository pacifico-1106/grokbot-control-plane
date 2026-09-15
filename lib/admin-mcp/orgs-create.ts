/**
 * Platform super-admin org provisioning via Admin MCP (orgs.create / orgs.status).
 * Reuses signup pipeline — no second org-creation path.
 */
import { randomBytes } from "node:crypto";
import { provisionOrgForUser } from "@/lib/auth/session";
import type { PlatformOpsActor } from "@/lib/admin/platform-ops-gate";
import { sendTrialStartedEmail, sendWelcomeEmail } from "@/lib/email";
import { getOrgMeta } from "@/lib/data/org-context";
import { getSubscription } from "@/lib/data/subscriptions";
import { decryptNotificationSecrets, encryptNotificationSecrets } from "@/lib/notify/crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { normalizeMemberEmail } from "@/lib/data/members";
import { DEMO_ORG } from "@/lib/demo-data";

export const DEFAULT_TRIAL_DAYS = 14;
export const MAX_TRIAL_DAYS = 365;

export type OrgCreateInput = {
  orgName: string;
  ownerEmail: string;
  integrationMode: "managed" | "byo";
  trialDays: number;
  invite: boolean;
  ownerDisplayName?: string;
  ownerPassword?: string;
};

export type OrgCreateSuccess = {
  orgId: string;
  ownerUserId: string;
  ownerEmail: string;
  trialEndsAt: string | null;
  integrationMode: "managed" | "byo";
  summaryJa: string;
  nextStepJa: string;
  recovered?: boolean;
};

export function clampTrialDays(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TRIAL_DAYS;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw Object.assign(new Error("invalid_trial_days"), {
      code: "invalid_trial_days",
      messageJa: `trialDays は 1〜${MAX_TRIAL_DAYS} の整数です`,
    });
  }
  if (n < 1 || n > MAX_TRIAL_DAYS) {
    throw Object.assign(new Error("invalid_trial_days"), {
      code: "invalid_trial_days",
      messageJa: `trialDays は 1〜${MAX_TRIAL_DAYS} の整数です（既定 ${DEFAULT_TRIAL_DAYS}）`,
    });
  }
  return n;
}

export function validateOrgCreateInput(
  args: Record<string, unknown>
):
  | { ok: true; value: OrgCreateInput }
  | { ok: false; code: string; message: string } {
  const orgName = String(args.orgName || "").trim();
  const ownerEmail = normalizeMemberEmail(String(args.ownerEmail || ""));
  const integrationMode =
    String(args.integrationMode || "managed").trim() === "byo" ? "byo" : "managed";
  const ownerDisplayName = String(args.ownerDisplayName || "").trim() || undefined;
  const invite = args.invite === true;
  const ownerPassword =
    typeof args.ownerPassword === "string" && args.ownerPassword.length > 0
      ? args.ownerPassword
      : undefined;

  if (!orgName) {
    return { ok: false, code: "org_name_required", message: "orgName が必要です" };
  }
  if (!ownerEmail || !ownerEmail.includes("@")) {
    return { ok: false, code: "owner_email_required", message: "ownerEmail が必要です" };
  }

  let trialDays: number;
  try {
    trialDays = clampTrialDays(args.trialDays);
  } catch (e) {
    const rec = e as { code?: string; messageJa?: string };
    return {
      ok: false,
      code: rec.code || "invalid_trial_days",
      message: rec.messageJa || "trialDays が不正です",
    };
  }

  if (!invite && !ownerPassword) {
    return {
      ok: false,
      code: "password_or_invite_required",
      message:
        "新規 Auth ユーザーには ownerPassword（8文字以上）または invite=true が必要です",
    };
  }
  if (ownerPassword && ownerPassword.length < 8) {
    return {
      ok: false,
      code: "password_min_8",
      message: "ownerPassword は8文字以上にしてください",
    };
  }

  return {
    ok: true,
    value: {
      orgName,
      ownerEmail,
      integrationMode,
      trialDays,
      invite,
      ownerDisplayName,
      ownerPassword,
    },
  };
}

export function queueOrgCreateArgs(
  value: OrgCreateInput,
  jobId?: string
): Record<string, unknown> {
  const password = value.ownerPassword;
  return {
    orgName: value.orgName,
    ownerEmail: value.ownerEmail,
    integrationMode: value.integrationMode,
    trialDays: value.trialDays,
    invite: value.invite,
    ownerDisplayName: value.ownerDisplayName ?? null,
    ownerPasswordPresent: Boolean(password),
    ...(password
      ? { ownerPasswordCiphertext: encryptNotificationSecrets({ ownerPassword: password }) }
      : {}),
    jobId,
  };
}

function resolveQueuedOwnerPassword(args: Record<string, unknown>): string | undefined {
  const ciphertext = String(args.ownerPasswordCiphertext || "").trim();
  if (!ciphertext) return undefined;
  return decryptNotificationSecrets(ciphertext).ownerPassword;
}

function generateInvitePassword(): string {
  return `${randomBytes(18).toString("base64url")}Aa1`;
}

async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  let page = 1;
  const perPage = 200;
  const target = email.toLowerCase();
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((user) => (user.email || "").toLowerCase() === target);
    if (hit?.id) return hit.id;
    if (data.users.length < perPage) return null;
    page += 1;
    if (page > 50) return null;
  }
}

async function activeMemberOrgIdForEmail(email: string): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("org_members")
    .select("org_id")
    .ilike("email", email)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  return data?.org_id ? String(data.org_id) : null;
}

export async function platformCreateOrg(
  input: OrgCreateInput,
  _actor: PlatformOpsActor
): Promise<OrgCreateSuccess> {
  if (isDemoMode()) {
    const trialEndsAt = new Date(
      Date.now() + input.trialDays * 86400000
    ).toISOString();
    return {
      orgId: `org_demo_${Date.now().toString(36)}`,
      ownerUserId: `user_demo_${Date.now().toString(36)}`,
      ownerEmail: input.ownerEmail,
      trialEndsAt,
      integrationMode: input.integrationMode,
      summaryJa: `デモ: ${input.orgName} を作成しました（${input.ownerEmail}）`,
      nextStepJa:
        "次は employees.issue で AI社員を発行してください。管理 MCP は新 org の gb_adm_ を別途発行後に接続します。",
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  const email = normalizeMemberEmail(input.ownerEmail);
  const existingOrgId = await activeMemberOrgIdForEmail(email);
  if (existingOrgId) {
    throw Object.assign(new Error("email_exists_has_org"), {
      code: "email_exists",
      messageJa:
        "このメールは既に組織に所属しています。別メールを使うか、既存 org を確認してください。",
    });
  }

  let password = input.ownerPassword;
  if (input.invite && !password) {
    password = generateInvitePassword();
  }
  if (!password || password.length < 8) {
    throw Object.assign(new Error("password_required"), {
      code: "password_required",
      messageJa: "ownerPassword（8文字以上）または invite=true が必要です",
    });
  }

  let userId: string;
  let recovered = false;

  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: input.ownerDisplayName ? { display_name: input.ownerDisplayName } : undefined,
  });

  if (authErr || !created.user) {
    const msg = authErr?.message || "auth_user_create_failed";
    if (!/already|registered|exists/i.test(msg)) {
      throw new Error(msg);
    }
    const existingUserId = await findAuthUserIdByEmail(email);
    if (!existingUserId) {
      throw Object.assign(new Error(`email_exists:${msg}`), {
        code: "email_exists",
        messageJa: "このメールは既に登録されていますがユーザー解決に失敗しました",
      });
    }
    userId = existingUserId;
    recovered = true;
  } else {
    userId = created.user.id;
  }

  const provisioned = await provisionOrgForUser({
    userId,
    email,
    orgName: input.orgName,
    integrationMode: input.integrationMode,
    displayName: input.ownerDisplayName,
    trialDays: input.trialDays,
  });

  void sendWelcomeEmail(email, input.orgName).catch(() => null);
  void sendTrialStartedEmail(email, input.trialDays).catch(() => null);

  const orgMeta = await getOrgMeta(provisioned.orgId);

  return {
    orgId: provisioned.orgId,
    ownerUserId: userId,
    ownerEmail: email,
    trialEndsAt: orgMeta.trialEndsAt,
    integrationMode: orgMeta.integrationMode,
    recovered,
    summaryJa: `${input.orgName} を作成しました（オーナー: ${email}・トライアル ${input.trialDays} 日）`,
    nextStepJa:
      "次は employees.issue で AI社員を発行してください。管理 MCP は新 org の gb_adm_ を別途発行後に接続します。",
  };
}

export async function platformOrgStatus(orgId: string): Promise<Record<string, unknown>> {
  const id = orgId.trim();
  if (!id) {
    return { ok: false, code: "org_id_required", message: "orgId が必要です" };
  }

  if (isDemoMode()) {
    const subscription = await getSubscription(DEMO_ORG.id);
    return {
      ok: true,
      orgId: id === DEMO_ORG.id ? DEMO_ORG.id : id,
      orgName: DEMO_ORG.name,
      integrationMode: DEMO_ORG.integrationMode,
      gatewayStatus: DEMO_ORG.gatewayStatus,
      trialEndsAt: DEMO_ORG.trialEndsAt,
      subscriptionStatus: subscription?.status ?? "trialing",
      planKey: subscription?.planKey ?? "business",
      summaryJa: `org ${id} · trialing`,
      nextStepJa: "orgs.create で新規テナントを作成する場合は人の承認が必要です。",
    };
  }

  const orgMeta = await getOrgMeta(id);
  const subscription = await getSubscription(id);
  const status = subscription?.status ?? "unknown";

  return {
    ok: true,
    orgId: orgMeta.id,
    orgName: orgMeta.name,
    integrationMode: orgMeta.integrationMode,
    gatewayStatus: orgMeta.gatewayStatus,
    trialEndsAt: orgMeta.trialEndsAt,
    subscriptionStatus: status,
    planKey: subscription?.planKey ?? null,
    summaryJa: `${orgMeta.name} · ${status}`,
    nextStepJa: "トライアル延長は Super Admin ダッシュボードまたは別オペレーションで行います。",
  };
}

export async function fulfillOrgCreateFromQueuedArgs(
  args: Record<string, unknown>,
  actor: PlatformOpsActor
): Promise<OrgCreateSuccess> {
  const parsed = validateOrgCreateInput({
    orgName: args.orgName,
    ownerEmail: args.ownerEmail,
    integrationMode: args.integrationMode,
    trialDays: args.trialDays,
    invite: args.invite,
    ownerDisplayName: args.ownerDisplayName,
    ownerPassword: resolveQueuedOwnerPassword(args),
  });
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return platformCreateOrg(parsed.value, actor);
}
