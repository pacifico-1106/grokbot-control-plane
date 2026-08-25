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
  provider: NotificationProvider;
  label?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
};

const demoChannels: NotificationChannelRuntime[] = [];

function demoPublic(row: NotificationChannelRuntime): NotificationChannel {
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    label: row.label,
    enabled: row.enabled,
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
    label: String(row.label || (provider === "telegram" ? "Telegram" : "LINE")),
    enabled: Boolean(row.enabled),
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
    return demoChannels.filter((row) => row.orgId === orgId).map(demoPublic);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("org_notification_channels")
    .select("*")
    .eq("org_id", orgId)
    .order("provider");
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

export async function upsertNotificationChannel(
  input: UpsertNotificationChannelInput
): Promise<NotificationChannel> {
  const cleanSecrets = Object.fromEntries(
    Object.entries(input.secrets || {}).filter(([, value]) => value.trim())
  );
  if (isDemoMode()) {
    const idx = demoChannels.findIndex(
      (row) => row.orgId === input.orgId && row.provider === input.provider
    );
    const existing = idx >= 0 ? demoChannels[idx] : null;
    const now = new Date().toISOString();
    const row: NotificationChannelRuntime = {
      id: existing?.id || `chn_${randomBytes(6).toString("hex")}`,
      orgId: input.orgId || DEMO_ORG.id,
      provider: input.provider,
      label: input.label?.trim() || (input.provider === "telegram" ? "Telegram" : "LINE"),
      enabled: input.enabled,
      config: input.config,
      webhookRef: existing?.webhookRef || randomBytes(6).toString("hex"),
      hasCredentials: Boolean(Object.keys(cleanSecrets).length || existing?.hasCredentials),
      webhookPath: "",
      secrets: { ...(existing?.secrets || {}), ...cleanSecrets },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (input.enabled && input.provider === "telegram" && (!row.secrets.botToken || !row.secrets.webhookSecret)) {
      throw new Error("telegram_credentials_incomplete");
    }
    if (input.enabled && input.provider === "line" && (!row.secrets.channelAccessToken || !row.secrets.channelSecret)) {
      throw new Error("line_credentials_incomplete");
    }
    row.webhookPath = webhookPath(row.provider, row.webhookRef);
    if (idx >= 0) demoChannels[idx] = row;
    else demoChannels.push(row);
    return demoPublic(row);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data: existing } = await admin
    .from("org_notification_channels")
    .select("*")
    .eq("org_id", input.orgId)
    .eq("provider", input.provider)
    .maybeSingle();
  let existingCiphertext = "";
  if (existing?.id) {
    const { data: existingSecret } = await admin
      .from("org_notification_channel_secrets")
      .select("credentials_ciphertext")
      .eq("channel_id", existing.id)
      .maybeSingle();
    existingCiphertext = String(existingSecret?.credentials_ciphertext || "");
  }
  let secrets = cleanSecrets;
  if (existingCiphertext) {
    secrets = {
      ...decryptNotificationSecrets(existingCiphertext),
      ...cleanSecrets,
    };
  }
  if (input.enabled && Object.keys(secrets).length === 0) {
    throw new Error("notification_credentials_required");
  }
  if (input.enabled && input.provider === "telegram" && (!secrets.botToken || !secrets.webhookSecret)) {
    throw new Error("telegram_credentials_incomplete");
  }
  if (input.enabled && input.provider === "line" && (!secrets.channelAccessToken || !secrets.channelSecret)) {
    throw new Error("line_credentials_incomplete");
  }
  const encryptedSecrets = Object.keys(secrets).length > 0
    ? encryptNotificationSecrets(secrets)
    : "";
  const payload = {
    org_id: input.orgId,
    provider: input.provider,
    label: input.label?.trim() || (input.provider === "telegram" ? "Telegram" : "LINE"),
    enabled: input.enabled,
    config: input.config,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin
    .from("org_notification_channels")
    .upsert(payload, { onConflict: "org_id,provider" })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "notification_channel_save_failed");
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
    has_credentials: Object.keys(secrets).length > 0,
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
  const configured = await runtimeRows({ orgId, provider: "telegram" });
  return configured.length === 0;
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
  if (isDemoMode()) return;
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
  if (isDemoMode()) return null;
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
  if (isDemoMode()) return null;
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
