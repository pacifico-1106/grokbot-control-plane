import { randomBytes } from "node:crypto";
import { DEMO_ORG } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import {
  decryptNotificationSecrets,
  encryptNotificationSecrets,
} from "@/lib/notify/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { ConversationAdapter, ConversationSurface } from "@/lib/types";

export type ConversationAdapterRuntime = ConversationAdapter & {
  secrets: Record<string, string>;
};

export type UpsertConversationAdapterInput = {
  orgId: string;
  surface: ConversationSurface;
  label?: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
};

const demoAdapters: ConversationAdapterRuntime[] = [];

function demoPublic(row: ConversationAdapterRuntime): ConversationAdapter {
  return {
    id: row.id,
    orgId: row.orgId,
    surface: row.surface,
    label: row.label,
    enabled: row.enabled,
    config: row.config,
    hasCredentials: row.hasCredentials,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPublic(row: Record<string, unknown>): ConversationAdapter {
  const surface = row.surface as ConversationSurface;
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    surface,
    label: String(row.label || (surface === "slack" ? "Slack" : surface)),
    enabled: Boolean(row.enabled),
    config:
      row.config && typeof row.config === "object"
        ? (row.config as Record<string, unknown>)
        : {},
    hasCredentials: Boolean(row.has_credentials),
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

function mapRuntime(row: Record<string, unknown>): ConversationAdapterRuntime {
  return {
    ...mapPublic(row),
    secrets: decryptNotificationSecrets(String(row.credentials_ciphertext || "")),
  };
}

async function credentialsByAdapterIds(
  adapterIds: string[]
): Promise<Map<string, string>> {
  if (adapterIds.length === 0) return new Map();
  const admin = createSupabaseAdminClient();
  if (!admin) return new Map();
  const { data, error } = await admin
    .from("org_conversation_adapter_secrets")
    .select("adapter_id,credentials_ciphertext")
    .in("adapter_id", adapterIds);
  if (error || !data) return new Map();
  return new Map(
    data.map((row) => [String(row.adapter_id), String(row.credentials_ciphertext || "")])
  );
}

export async function listConversationAdapters(
  orgId?: string | null
): Promise<ConversationAdapter[]> {
  if (!orgId) return [];
  if (isDemoMode()) {
    return demoAdapters.filter((row) => row.orgId === orgId).map(demoPublic);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("org_conversation_adapters")
    .select("*")
    .eq("org_id", orgId)
    .order("surface");
  if (error || !data) return [];
  const credentials = await credentialsByAdapterIds(data.map((row) => String(row.id)));
  return data.map((row) =>
    mapPublic({
      ...(row as Record<string, unknown>),
      has_credentials: credentials.has(String(row.id)),
    })
  );
}

export async function getEnabledConversationAdapter(
  orgId: string,
  surface: ConversationSurface
): Promise<ConversationAdapterRuntime | null> {
  if (isDemoMode()) {
    return (
      demoAdapters.find(
        (row) => row.orgId === orgId && row.surface === surface && row.enabled
      ) ?? null
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("org_conversation_adapters")
    .select("*")
    .eq("org_id", orgId)
    .eq("surface", surface)
    .eq("enabled", true)
    .maybeSingle();
  if (error || !data) return null;
  const credentials = await credentialsByAdapterIds([String(data.id)]);
  const ciphertext = credentials.get(String(data.id));
  if (!ciphertext) return null;
  try {
    return mapRuntime({
      ...(data as Record<string, unknown>),
      has_credentials: true,
      credentials_ciphertext: ciphertext,
    });
  } catch (error) {
    console.error("conversation_adapter_decrypt_failed", String(data.id), error);
    return null;
  }
}

export async function upsertConversationAdapter(
  input: UpsertConversationAdapterInput
): Promise<ConversationAdapter> {
  const cleanSecrets = Object.fromEntries(
    Object.entries(input.secrets || {}).filter(([, value]) => value.trim())
  );
  if (isDemoMode()) {
    const idx = demoAdapters.findIndex(
      (row) => row.orgId === input.orgId && row.surface === input.surface
    );
    const existing = idx >= 0 ? demoAdapters[idx] : null;
    const now = new Date().toISOString();
    const row: ConversationAdapterRuntime = {
      id: existing?.id || `cad_${randomBytes(6).toString("hex")}`,
      orgId: input.orgId || DEMO_ORG.id,
      surface: input.surface,
      label: input.label?.trim() || (input.surface === "slack" ? "Slack 会話投稿" : input.surface),
      enabled: input.enabled,
      config: input.config || existing?.config || {},
      hasCredentials: Boolean(Object.keys(cleanSecrets).length || existing?.hasCredentials),
      secrets: { ...(existing?.secrets || {}), ...cleanSecrets },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (input.enabled && input.surface === "slack" && !row.secrets.botToken) {
      throw new Error("slack_adapter_token_required");
    }
    if (idx >= 0) demoAdapters[idx] = row;
    else demoAdapters.push(row);
    return demoPublic(row);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data: existing } = await admin
    .from("org_conversation_adapters")
    .select("*")
    .eq("org_id", input.orgId)
    .eq("surface", input.surface)
    .maybeSingle();
  let existingCiphertext = "";
  if (existing?.id) {
    const { data: existingSecret } = await admin
      .from("org_conversation_adapter_secrets")
      .select("credentials_ciphertext")
      .eq("adapter_id", existing.id)
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
  if (input.enabled && input.surface === "slack" && !secrets.botToken) {
    throw new Error("slack_adapter_token_required");
  }
  const encryptedSecrets = Object.keys(secrets).length > 0
    ? encryptNotificationSecrets(secrets)
    : "";
  const payload = {
    org_id: input.orgId,
    surface: input.surface,
    label: input.label?.trim() || (input.surface === "slack" ? "Slack 会話投稿" : input.surface),
    enabled: input.enabled,
    config: input.config || {},
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin
    .from("org_conversation_adapters")
    .upsert(payload, { onConflict: "org_id,surface" })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "conversation_adapter_save_failed");
  if (Object.keys(secrets).length > 0) {
    const { error: secretError } = await admin
      .from("org_conversation_adapter_secrets")
      .upsert(
        {
          adapter_id: data.id,
          credentials_ciphertext: encryptedSecrets,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "adapter_id" }
      );
    if (secretError) throw new Error(secretError.message || "conversation_adapter_secret_save_failed");
  }
  return mapPublic({
    ...(data as Record<string, unknown>),
    has_credentials: Object.keys(secrets).length > 0,
  });
}
