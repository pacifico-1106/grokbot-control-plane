import { randomBytes } from "node:crypto";
import { DEMO_ORG } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import {
  decryptNotificationSecrets,
  encryptNotificationSecrets,
} from "@/lib/notify/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { mapApprovalRow } from "@/lib/data/mappers";
import type {
  ApprovalRequest,
  NotificationChannel,
  NotificationProvider,
} from "@/lib/types";

export type NotificationChannelRuntime = NotificationChannel & {
  secrets: Record<string, string>;
};

export type UpsertNotificationChannelInput = {
  orgId: string;
  id?: string;
  provider: NotificationProvider;
  label?: string;
  enabled: boolean;
  isDefault?: boolean;
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
};

const demoChannels: NotificationChannelRuntime[] = [];

type DemoDelivery = {
  approvalId: string;
  orgId: string;
  channelId: string;
  provider: NotificationProvider;
  externalMessageId: string | null;
  context: Record<string, unknown>;
};

const demoDeliveries: DemoDelivery[] = [];

function defaultProviderLabel(provider: NotificationProvider): string {
  if (provider === "telegram") return "Telegram";
  if (provider === "line") return "LINE";
  return "Slack";
}

function demoPublic(row: NotificationChannelRuntime): NotificationChannel {
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    label: row.label,
    enabled: row.enabled,
    isDefault: Boolean(row.isDefault),
    config: row.config,
    webhookRef: row.webhookRef,
    hasCredentials: row.hasCredentials,
    webhookPath: row.webhookPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function webhookPath(provider: NotificationProvider, ref: string): string {
  return `/api/webhooks/${provider}/${encodeURIComponent(ref)}`;
}

function mapPublic(row: Record<string, unknown>): NotificationChannel {
  const provider = row.provider as NotificationProvider;
  const webhookRef = String(row.webhook_ref || "");
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    provider,
    label: String(row.label || defaultProviderLabel(provider)),
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    config:
      row.config && typeof row.config === "object"
        ? (row.config as Record<string, unknown>)
        : {},
    webhookRef,
    hasCredentials: Boolean(row.has_credentials),
    webhookPath: webhookPath(provider, webhookRef),
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

function mapRuntime(row: Record<string, unknown>): NotificationChannelRuntime {
  const channel = mapPublic(row);
  return {
    ...channel,
    secrets: decryptNotificationSecrets(String(row.credentials_ciphertext || "")),
  };
}

async function credentialsByChannelIds(
  channelIds: string[]
): Promise<Map<string, string>> {
  if (channelIds.length === 0) return new Map();
  const admin = createSupabaseAdminClient();
  if (!admin) return new Map();
  const { data, error } = await admin
    .from("org_notification_channel_secrets")
    .select("channel_id,credentials_ciphertext")
    .in("channel_id", channelIds);
  if (error || !data) return new Map();
  return new Map(
    data.map((row) => [String(row.channel_id), String(row.credentials_ciphertext || "")])
  );
}

export async function listNotificationChannels(
  orgId?: string | null
): Promise<NotificationChannel[]> {
  if (!orgId) return [];
  if (isDemoMode()) {
    return demoChannels
      .filter((row) => row.orgId === orgId)
      .slice()
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt))
      .map(demoPublic);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("org_notification_channels")
    .select("*")
    .eq("org_id", orgId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  const credentials = await credentialsByChannelIds(data.map((row) => String(row.id)));
  return data.map((row) =>
    mapPublic({
      ...(row as Record<string, unknown>),
      has_credentials: credentials.has(String(row.id)),
    })
  );
}

async function runtimeRows(
  filters: { orgId?: string; provider?: NotificationProvider; webhookRef?: string } = {}
): Promise<NotificationChannelRuntime[]> {
  if (isDemoMode()) {
    return demoChannels.filter(
      (row) =>
        (!filters.orgId || row.orgId === filters.orgId) &&
        (!filters.provider || row.provider === filters.provider) &&
        (!filters.webhookRef || row.webhookRef === filters.webhookRef) &&
        row.enabled
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  let query = admin.from("org_notification_channels").select("*").eq("enabled", true);
  if (filters.orgId) query = query.eq("org_id", filters.orgId);
  if (filters.provider) query = query.eq("provider", filters.provider);
  if (filters.webhookRef) query = query.eq("webhook_ref", filters.webhookRef);
  const { data, error } = await query;
  if (error || !data) return [];
  const credentials = await credentialsByChannelIds(data.map((row) => String(row.id)));
  const result: NotificationChannelRuntime[] = [];
  for (const row of data) {
    try {
      const ciphertext = credentials.get(String(row.id));
      if (!ciphertext) continue;
      result.push(
        mapRuntime({
          ...(row as Record<string, unknown>),
          has_credentials: true,
          credentials_ciphertext: ciphertext,
        })
      );
    } catch (error) {
      console.error("notification_channel_decrypt_failed", String((row as { id?: unknown }).id), error);
    }
  }
  return result;
}

export async function getEnabledNotificationChannels(
  orgId: string
): Promise<NotificationChannelRuntime[]> {
  return runtimeRows({ orgId });
}

export async function listAllEnabledNotificationChannels(): Promise<NotificationChannelRuntime[]> {
  return runtimeRows();
}

export async function getNotificationChannelByWebhookRef(
  provider: NotificationProvider,
  ref: string
): Promise<NotificationChannelRuntime | null> {
  return (await runtimeRows({ provider, webhookRef: ref }))[0] ?? null;
}

function telegramEnvConfig() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
    chatId: process.env.TELEGRAM_APPROVAL_CHAT_ID?.trim() || "",
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || "",
    allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

async function applyTelegramPilotEnvReuse(input: {
  orgId: string;
  id?: string;
  provider: NotificationProvider;
  enabled: boolean;
  isDefault?: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}): Promise<{
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  isDefault?: boolean;
}> {
  if (input.provider !== "telegram" || !input.enabled) {
    return { config: input.config, secrets: input.secrets, isDefault: input.isDefault };
  }
  const env = telegramEnvConfig();
  const secrets = { ...input.secrets };
  let config = { ...input.config };
  let isDefault = input.isDefault;
  const hadToken = Boolean(secrets.botToken?.trim());
  const isPilot = await isTokyo307PilotOrg(input.orgId);
  if (!hadToken) {
    if (isPilot && env.token) {
      secrets.botToken = env.token;
      if (env.webhookSecret) secrets.webhookSecret = env.webhookSecret;
    }
  } else if (isPilot && env.token && secrets.botToken.trim() === env.token && env.webhookSecret) {
    secrets.webhookSecret = env.webhookSecret;
  }
  const usingEnvBot = Boolean(env.token && secrets.botToken?.trim() === env.token);
  if (usingEnvBot && isPilot) {
    const chatId = String(config.chatId || "").trim();
    if (!chatId) {
      const others = (await listNotificationChannels(input.orgId)).filter(
        (row) => row.provider === "telegram" && row.id !== input.id
      );
      if (others.length > 0 || !env.chatId) {
        throw new Error("destination_required");
      }
      config = { ...config, chatId: env.chatId };
      if (!Array.isArray(config.allowedUserIds) || config.allowedUserIds.length === 0) {
        if (env.allowedUserIds.length > 0) {
          config = { ...config, allowedUserIds: env.allowedUserIds };
        }
      }
      isDefault = true;
    }
  }
  return { config, secrets, isDefault };
}

function assertProviderSecrets(
  provider: NotificationProvider,
  enabled: boolean,
  secrets: Record<string, string>
) {
  if (!enabled) return;
  if (provider === "telegram" && (!secrets.botToken || !secrets.webhookSecret)) {
    throw new Error("telegram_credentials_incomplete");
  }
  if (provider === "line" && (!secrets.channelAccessToken || !secrets.channelSecret)) {
    throw new Error("line_credentials_incomplete");
  }
  if (provider === "slack" && (!secrets.botToken || !secrets.signingSecret)) {
    throw new Error("slack_credentials_incomplete");
  }
}

function markOrgDefaultDemo(orgId: string, channelId: string) {
  for (const row of demoChannels) {
    if (row.orgId === orgId) row.isDefault = row.id === channelId;
  }
}

export async function upsertNotificationChannel(
  input: UpsertNotificationChannelInput
): Promise<NotificationChannel> {
  const cleanSecrets = Object.fromEntries(
    Object.entries(input.secrets || {}).filter(([, value]) => value.trim())
  );
  if (isDemoMode()) {
    const idx = input.id
      ? demoChannels.findIndex((row) => row.id === input.id && row.orgId === input.orgId)
      : -1;
    const existing = idx >= 0 ? demoChannels[idx] : null;
    const applied = await applyTelegramPilotEnvReuse({
      orgId: input.orgId,
      id: existing?.id,
      provider: input.provider,
      enabled: input.enabled,
      isDefault: input.isDefault,
      config: input.config,
      secrets: { ...(existing?.secrets || {}), ...cleanSecrets },
    });
    const now = new Date().toISOString();
    const orgRows = demoChannels.filter((row) => row.orgId === input.orgId);
    const wantsDefault =
      applied.isDefault === true || (!existing && !orgRows.some((row) => row.isDefault));
    const row: NotificationChannelRuntime = {
      id: existing?.id || `chn_${randomBytes(6).toString("hex")}`,
      orgId: input.orgId || DEMO_ORG.id,
      provider: input.provider,
      label: input.label?.trim() || defaultProviderLabel(input.provider),
      enabled: input.enabled,
      isDefault: wantsDefault || Boolean(existing?.isDefault && applied.isDefault !== false),
      config: applied.config,
      webhookRef: existing?.webhookRef || randomBytes(6).toString("hex"),
      hasCredentials: Boolean(Object.keys(applied.secrets).length || existing?.hasCredentials),
      webhookPath: "",
      secrets: applied.secrets,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    assertProviderSecrets(input.provider, input.enabled, row.secrets);
    row.webhookPath = webhookPath(row.provider, row.webhookRef);
    if (idx >= 0) demoChannels[idx] = row;
    else demoChannels.push(row);
    const orgHasDefault = demoChannels.some((item) => item.orgId === row.orgId && item.isDefault);
    if (wantsDefault || !orgHasDefault) markOrgDefaultDemo(row.orgId, row.id);
    return demoPublic(row);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  let existing: Record<string, unknown> | null = null;
  if (input.id) {
    const { data } = await admin
      .from("org_notification_channels")
      .select("*")
      .eq("org_id", input.orgId)
      .eq("id", input.id)
      .maybeSingle();
    existing = (data as Record<string, unknown> | null) ?? null;
  }
  let existingCiphertext = "";
  if (existing?.id) {
    const { data: existingSecret } = await admin
      .from("org_notification_channel_secrets")
      .select("credentials_ciphertext")
      .eq("channel_id", existing.id)
      .maybeSingle();
    existingCiphertext = String(existingSecret?.credentials_ciphertext || "");
  }
  const mergedSecrets = existingCiphertext
    ? { ...decryptNotificationSecrets(existingCiphertext), ...cleanSecrets }
    : cleanSecrets;
  const applied = await applyTelegramPilotEnvReuse({
    orgId: input.orgId,
    id: existing?.id ? String(existing.id) : undefined,
    provider: input.provider,
    enabled: input.enabled,
    isDefault: input.isDefault,
    config: input.config,
    secrets: mergedSecrets,
  });
  const secrets = applied.secrets;
  if (input.enabled && Object.keys(secrets).length === 0) {
    throw new Error("notification_credentials_required");
  }
  assertProviderSecrets(input.provider, input.enabled, secrets);
  const encryptedSecrets = Object.keys(secrets).length > 0
    ? encryptNotificationSecrets(secrets)
    : "";
  const { data: orgRows } = await admin
    .from("org_notification_channels")
    .select("id,is_default")
    .eq("org_id", input.orgId);
  const hasDefault = (orgRows || []).some(
    (row) => Boolean((row as { is_default?: boolean }).is_default) && String((row as { id: string }).id) !== String(existing?.id || "")
  );
  const keepDefault = Boolean(existing?.is_default) && applied.isDefault !== false;
  const wantsDefault = applied.isDefault === true || (!existing && !hasDefault);
  const payload = {
    org_id: input.orgId,
    provider: input.provider,
    label: input.label?.trim() || defaultProviderLabel(input.provider),
    enabled: input.enabled,
    is_default: (wantsDefault || keepDefault) && !hasDefault,
    config: applied.config,
    updated_at: new Date().toISOString(),
  };
  const query = existing?.id
    ? admin.from("org_notification_channels").update(payload).eq("id", existing.id).eq("org_id", input.orgId)
    : admin.from("org_notification_channels").insert(payload);
  const { data, error } = await query.select("*").single();
  if (error || !data) throw new Error(error?.message || "notification_channel_save_failed");
  if (wantsDefault) {
    await admin
      .from("org_notification_channels")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("org_id", input.orgId)
      .neq("id", data.id);
    await admin
      .from("org_notification_channels")
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    (data as { is_default: boolean }).is_default = true;
  }
  if (Object.keys(secrets).length > 0) {
    const { error: secretError } = await admin
      .from("org_notification_channel_secrets")
      .upsert(
        {
          channel_id: data.id,
          credentials_ciphertext: encryptedSecrets,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "channel_id" }
      );
    if (secretError) throw new Error(secretError.message || "notification_channel_secret_save_failed");
  }
  return mapPublic({
    ...(data as Record<string, unknown>),
    has_credentials: Object.keys(secrets).length > 0 || Boolean(existingCiphertext),
  });
}

export async function isTokyo307PilotOrg(orgId: string): Promise<boolean> {
  const pilotEmail = "info@tokyo307inc.com";
  if (isDemoMode()) return orgId === DEMO_ORG.id;
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return false;
  const { data, error } = await admin
    .from("org_members")
    .select("id")
    .eq("org_id", orgId)
    .ilike("email", pilotEmail)
    .eq("status", "active")
    .limit(1);
  return !error && Boolean(data?.length);
}

export function isTokyo307PilotEmail(email: string | null | undefined): boolean {
  return (email || "").trim().toLowerCase() === "info@tokyo307inc.com";
}

export async function shouldUseGlobalTelegramFallback(orgId: string): Promise<boolean> {
  if (!(await isTokyo307PilotOrg(orgId))) return false;
  const configured = (await listNotificationChannels(orgId)).filter(
    (row) => row.provider === "telegram"
  );
  return configured.length === 0;
}

export async function findPilotTelegramChannelByChatId(
  chatId: string
): Promise<NotificationChannelRuntime | null> {
  const id = String(chatId || "").trim();
  if (!id) return null;
  const orgId = isDemoMode() ? DEMO_ORG.id : await getTokyo307PilotOrgId();
  if (!orgId) return null;
  const channels = await runtimeRows({ orgId, provider: "telegram" });
  return channels.find((channel) => String(channel.config.chatId || "").trim() === id) ?? null;
}

export async function getTokyo307PilotOrgId(): Promise<string | null> {
  if (isDemoMode()) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("org_members")
    .select("org_id")
    .ilike("email", "info@tokyo307inc.com")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  return data?.org_id ? String(data.org_id) : null;
}

export async function recordNotificationDelivery(input: {
  approval: ApprovalRequest;
  channelId: string;
  provider: NotificationProvider;
  externalMessageId?: string | null;
  context?: Record<string, unknown>;
}): Promise<void> {
  if (isDemoMode()) {
    const row: DemoDelivery = {
      approvalId: input.approval.id,
      orgId: input.approval.orgId,
      channelId: input.channelId,
      provider: input.provider,
      externalMessageId: input.externalMessageId ?? null,
      context: input.context ?? {},
    };
    const idx = demoDeliveries.findIndex(
      (item) => item.approvalId === row.approvalId && item.channelId === row.channelId
    );
    if (idx >= 0) demoDeliveries[idx] = row;
    else demoDeliveries.push(row);
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin.from("approval_notification_deliveries").upsert(
    {
      approval_id: input.approval.id,
      org_id: input.approval.orgId,
      channel_id: input.channelId,
      provider: input.provider,
      external_message_id: input.externalMessageId ?? null,
      context: input.context ?? {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: "approval_id,channel_id" }
  );
}

export async function getNotificationDelivery(input: {
  approvalId: string;
  channelId: string;
}): Promise<{ externalMessageId: string | null; context: Record<string, unknown> } | null> {
  if (isDemoMode()) {
    const row = demoDeliveries.find(
      (item) => item.approvalId === input.approvalId && item.channelId === input.channelId
    );
    return row
      ? { externalMessageId: row.externalMessageId, context: row.context }
      : null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("approval_notification_deliveries")
    .select("external_message_id,context")
    .eq("approval_id", input.approvalId)
    .eq("channel_id", input.channelId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    externalMessageId: data.external_message_id ? String(data.external_message_id) : null,
    context:
      data.context && typeof data.context === "object"
        ? (data.context as Record<string, unknown>)
        : {},
  };
}

export async function getApprovalIdByDeliveryExternal(input: {
  channelId: string;
  externalMessageId: string;
}): Promise<string | null> {
  if (isDemoMode()) {
    const row = demoDeliveries.find(
      (item) =>
        item.channelId === input.channelId && item.externalMessageId === input.externalMessageId
    );
    return row ? row.approvalId : null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("approval_notification_deliveries")
    .select("approval_id")
    .eq("channel_id", input.channelId)
    .eq("external_message_id", input.externalMessageId)
    .maybeSingle();
  return error || !data ? null : String(data.approval_id);
}

export async function findAwaitingRevisionApproval(input: {
  orgId: string;
  channelId: string;
  provider: NotificationProvider;
  userId: string;
}): Promise<ApprovalRequest | null> {
  if (isDemoMode()) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("org_id", input.orgId)
    .eq("status", "pending")
    .contains("metadata", {
      awaiting_revision_from: input.userId,
      awaiting_revision_channel_id: input.channelId,
      awaiting_revision_provider: input.provider,
    })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return mapApprovalRow(data as Record<string, unknown>);
}

export function resetDemoNotificationChannels(orgId?: string): void {
  if (!orgId) {
    demoChannels.length = 0;
    demoDeliveries.length = 0;
    return;
  }
  const removed = new Set<string>();
  for (let i = demoChannels.length - 1; i >= 0; i -= 1) {
    if (demoChannels[i].orgId === orgId) {
      removed.add(demoChannels[i].id);
      demoChannels.splice(i, 1);
    }
  }
  for (let i = demoDeliveries.length - 1; i >= 0; i -= 1) {
    if (demoDeliveries[i].orgId === orgId || removed.has(demoDeliveries[i].channelId)) {
      demoDeliveries.splice(i, 1);
    }
  }
}

export async function resolveEmployeeApprovalChannel(
  orgId: string,
  employee?: { approvalChannelId?: string | null } | null
): Promise<NotificationChannelRuntime | null> {
  const channels = await getEnabledNotificationChannels(orgId);
  const requested = employee?.approvalChannelId?.trim() || "";
  if (requested) {
    const chosen = channels.find((channel) => channel.id === requested);
    if (chosen) return chosen;
  }
  return channels.find((channel) => channel.isDefault) ?? channels[0] ?? null;
}
