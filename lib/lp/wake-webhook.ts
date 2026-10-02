/**
 * LP Wake Webhook handler.
 * Allows external systems to trigger chat session resumption or notifications.
 * 
 * Feature flag: LP_WAKE_WEBHOOK_ENABLED (default OFF)
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isLpWakeWebhookEnabled } from "@/lib/feature-flags";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export type WebhookTriggerType = "journey_resume" | "notification" | "custom";

export interface WebhookConfig {
  id: string;
  tenantId: string;
  name: string;
  endpointPath: string;
  secretHash: string;
  triggerType: WebhookTriggerType;
  enabled: boolean;
  lastTriggeredAt: string | null;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEvent {
  id: string;
  tenantId: string;
  webhookConfigId: string;
  eventType: string;
  payloadHash: string | null;
  status: "received" | "processed" | "failed" | "duplicate";
  errorCode: string | null;
  idempotencyKey: string | null;
  receivedAt: string;
  processedAt: string | null;
  ipHash: string | null;
  userAgentHash: string | null;
}

export interface ValidateWebhookResult {
  valid: boolean;
  config: WebhookConfig | null;
  reason: string;
}

export interface ProcessWebhookInput {
  configId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  ipHash?: string;
  userAgentHash?: string;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function mapWebhookConfigRow(row: Record<string, unknown>): WebhookConfig {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    name: String(row.name),
    endpointPath: String(row.endpoint_path),
    secretHash: String(row.secret_hash),
    triggerType: String(row.trigger_type) as WebhookTriggerType,
    enabled: Boolean(row.enabled),
    lastTriggeredAt: row.last_triggered_at ? String(row.last_triggered_at) : null,
    triggerCount: Number(row.trigger_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function validateWebhookRequest(
  endpointPath: string,
  providedSecret: string
): Promise<ValidateWebhookResult> {
  if (!isLpWakeWebhookEnabled()) {
    return { valid: false, config: null, reason: "feature_disabled" };
  }

  if (!providedSecret || providedSecret.length < 16) {
    return { valid: false, config: null, reason: "invalid_secret" };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { valid: false, config: null, reason: "db_unavailable" };
  }

  const { data } = await admin
    .from("lp_wake_webhook_configs")
    .select("*")
    .eq("endpoint_path", endpointPath)
    .eq("enabled", true)
    .maybeSingle();

  if (!data) {
    return { valid: false, config: null, reason: "endpoint_not_found" };
  }

  const config = mapWebhookConfigRow(data as Record<string, unknown>);

  const providedHash = hashSecret(providedSecret);
  const storedHashBuffer = Buffer.from(config.secretHash, "hex");
  const providedHashBuffer = Buffer.from(providedHash, "hex");

  if (storedHashBuffer.length !== providedHashBuffer.length) {
    return { valid: false, config: null, reason: "invalid_secret" };
  }

  if (!timingSafeEqual(storedHashBuffer, providedHashBuffer)) {
    return { valid: false, config: null, reason: "invalid_secret" };
  }

  return { valid: true, config, reason: "ok" };
}

export async function checkIdempotency(
  configId: string,
  idempotencyKey: string
): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const { data } = await admin
    .from("lp_wake_webhook_events")
    .select("id")
    .eq("webhook_config_id", configId)
    .eq("idempotency_key", idempotencyKey)
    .limit(1)
    .maybeSingle();

  return !!data;
}

export async function recordWebhookEvent(input: ProcessWebhookInput): Promise<WebhookEvent | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const now = new Date().toISOString();

  if (input.idempotencyKey) {
    const isDuplicate = await checkIdempotency(input.configId, input.idempotencyKey);
    if (isDuplicate) {
      const { data } = await admin
        .from("lp_wake_webhook_events")
        .insert({
          tenant_id: DEFAULT_TENANT_ID,
          webhook_config_id: input.configId,
          event_type: input.eventType,
          payload_hash: hashPayload(input.payload),
          status: "duplicate",
          idempotency_key: input.idempotencyKey,
          received_at: now,
          ip_hash: input.ipHash || null,
          user_agent_hash: input.userAgentHash || null,
        })
        .select("*")
        .single();

      if (data) {
        return mapWebhookEventRow(data as Record<string, unknown>);
      }
      return null;
    }
  }

  const { data, error } = await admin
    .from("lp_wake_webhook_events")
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      webhook_config_id: input.configId,
      event_type: input.eventType,
      payload_hash: hashPayload(input.payload),
      status: "received",
      idempotency_key: input.idempotencyKey || null,
      received_at: now,
      ip_hash: input.ipHash || null,
      user_agent_hash: input.userAgentHash || null,
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[wake-webhook] Failed to record event:", error);
    return null;
  }

  await admin
    .from("lp_wake_webhook_configs")
    .update({
      last_triggered_at: now,
      trigger_count: admin.rpc("increment_trigger_count", { config_id: input.configId }),
      updated_at: now,
    })
    .eq("id", input.configId);

  return mapWebhookEventRow(data as Record<string, unknown>);
}

function mapWebhookEventRow(row: Record<string, unknown>): WebhookEvent {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    webhookConfigId: String(row.webhook_config_id),
    eventType: String(row.event_type),
    payloadHash: row.payload_hash ? String(row.payload_hash) : null,
    status: String(row.status) as WebhookEvent["status"],
    errorCode: row.error_code ? String(row.error_code) : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    receivedAt: String(row.received_at),
    processedAt: row.processed_at ? String(row.processed_at) : null,
    ipHash: row.ip_hash ? String(row.ip_hash) : null,
    userAgentHash: row.user_agent_hash ? String(row.user_agent_hash) : null,
  };
}

export async function updateWebhookEventStatus(
  eventId: string,
  status: "processed" | "failed",
  errorCode?: string
): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const updates: Record<string, unknown> = {
    status,
  };

  if (status === "processed") {
    updates.processed_at = new Date().toISOString();
  }

  if (errorCode) {
    updates.error_code = errorCode.slice(0, 50);
  }

  const { error } = await admin
    .from("lp_wake_webhook_events")
    .update(updates)
    .eq("id", eventId);

  return !error;
}

export async function createWebhookConfig(input: {
  name: string;
  endpointPath: string;
  secret: string;
  triggerType?: WebhookTriggerType;
}): Promise<WebhookConfig | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("lp_wake_webhook_configs")
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      name: input.name,
      endpoint_path: input.endpointPath,
      secret_hash: hashSecret(input.secret),
      trigger_type: input.triggerType || "journey_resume",
      enabled: true,
      trigger_count: 0,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[wake-webhook] Failed to create config:", error);
    return null;
  }

  return mapWebhookConfigRow(data as Record<string, unknown>);
}
