import { createHash, randomUUID } from "node:crypto";
import {
  CROSS_PRODUCT_SPEC_VERSION,
  signCrossProductEvent,
  type CommerceAuthorizationSnapshot,
} from "@/lib/commerce/cross-product-events";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { ApprovalRequest, Employee } from "@/lib/types";

type DeliveryResult = {
  ok: boolean;
  skipped?: boolean;
  eventId?: string;
  status?: number | null;
  error?: string;
};

type AuthorityIntegration = NonNullable<ReturnType<typeof config>>;
type AuthorityOutboxRow = {
  id: string;
  event_id: string;
  body_hash: string;
  raw_body: string | null;
  attempts: number;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_SECONDS = 30;

function positiveEnvInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function authorityDeliveryDisposition(
  status: number | null,
  attempts: number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
) {
  if (status !== null && status >= 200 && status < 300) return "delivered" as const;
  const retryable = status === null || status === 408 || status === 429 || status >= 500;
  return retryable && attempts < maxAttempts ? "retryable" as const : "dead_letter" as const;
}

function nextAttemptAt(attempts: number) {
  const baseSeconds = positiveEnvInteger(
    "CROSS_PRODUCT_EVENT_RETRY_BASE_SECONDS",
    DEFAULT_RETRY_BASE_SECONDS,
  );
  const delaySeconds = Math.min(baseSeconds * 2 ** Math.max(0, attempts - 1), 3600);
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

async function deliverOutboxRow(
  row: AuthorityOutboxRow,
  integration: AuthorityIntegration,
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
): Promise<DeliveryResult> {
  const attempts = Number(row.attempts ?? 0) + 1;
  const maxAttempts = positiveEnvInteger(
    "CROSS_PRODUCT_EVENT_MAX_ATTEMPTS",
    DEFAULT_MAX_ATTEMPTS,
  );
  const rawBody = row.raw_body;
  if (!rawBody || createHash("sha256").update(rawBody).digest("hex") !== row.body_hash) {
    await admin
      .from("cross_product_event_outbox")
      .update({
        status: "dead_letter",
        attempts,
        last_error: "outbox_body_hash_mismatch",
        dead_lettered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { ok: false, eventId: row.event_id, status: null, error: "outbox_body_hash_mismatch" };
  }
  const timestamp = String(Math.floor(Date.now() / 1_000));
  let status: number | null = null;
  let lastError: string | null = null;
  try {
    const response = await fetch(integration.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Staffpass-AuthorityEvent/1.0",
        ...(integration.vercelBypassSecret
          ? {
              "x-vercel-protection-bypass": integration.vercelBypassSecret,
              "x-vercel-set-bypass-cookie": "samesitenone",
            }
          : {}),
        "x-sealith-event-id": row.event_id,
        "x-sealith-event-timestamp": timestamp,
        "x-sealith-event-signature": `v1=${signCrossProductEvent(
          rawBody,
          timestamp,
          integration.secret,
        )}`,
      },
      body: rawBody,
      signal: AbortSignal.timeout(5_000),
    });
    status = response.status;
  } catch (error) {
    lastError = error instanceof Error ? error.message.slice(0, 300) : "delivery_failed";
  }
  const disposition = authorityDeliveryDisposition(status, attempts, maxAttempts);
  await admin
    .from("cross_product_event_outbox")
    .update({
      status: disposition,
      attempts,
      last_http_status: status,
      last_error: lastError,
      delivered_at: disposition === "delivered" ? new Date().toISOString() : null,
      next_attempt_at: disposition === "retryable" ? nextAttemptAt(attempts) : null,
      dead_lettered_at: disposition === "dead_letter" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  return {
    ok: disposition === "delivered",
    eventId: row.event_id,
    status,
    ...(lastError ? { error: "delivery_failed" } : {}),
  };
}

function config() {
  if (process.env.STAFFPASS_SEALITH_EVENTS_ENABLED !== "true") return null;
  const environment = process.env.CROSS_PRODUCT_EVENT_ENVIRONMENT;
  const endpoint = process.env.SEALITH_AUTHORITY_EVENTS_URL;
  const secret = process.env.STAFFPASS_SEALITH_EVENT_SECRET ?? "";
  const vercelBypassSecret =
    process.env.SEALITH_VERCEL_BYPASS_SECRET?.trim() || null;
  if (
    (environment !== "staging" && environment !== "production") ||
    !endpoint ||
    secret.length < 32
  ) {
    throw new Error("authority_event_config_invalid");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("authority_event_url_must_be_https");
  return {
    environment,
    endpoint: url.toString(),
    secret,
    vercelBypassSecret,
  } as const;
}

function snapshotFrom(approval: ApprovalRequest) {
  const crossProduct = approval.metadata.crossProductCommerce;
  if (!crossProduct || typeof crossProduct !== "object" || Array.isArray(crossProduct)) {
    return null;
  }
  const value = crossProduct as Record<string, unknown>;
  if (
    value.targetSystem !== "sealith" ||
    value.authorityMode !== "external_reference" ||
    !value.authorization ||
    typeof value.authorization !== "object"
  ) {
    return null;
  }
  return value as {
    targetSystem: "sealith";
    authorityMode: "external_reference";
    credentialGeneration: number;
    authorization: CommerceAuthorizationSnapshot;
  };
}

export async function deliverAuthorityDecision(input: {
  approval: ApprovalRequest;
  decision: "approved" | "rejected";
  actorEmail: string;
  employee?: Employee | null;
}): Promise<DeliveryResult> {
  const snapshot = snapshotFrom(input.approval);
  if (!snapshot) return { ok: true, skipped: true };
  if (!input.approval.jobId) {
    return { ok: false, error: "authority_job_id_missing" };
  }
  if (
    !Number.isInteger(snapshot.credentialGeneration) ||
    snapshot.credentialGeneration < 1
  ) {
    return { ok: false, error: "credential_generation_invalid" };
  }
  let integration;
  try {
    integration = config();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid_config" };
  }
  if (!integration) return { ok: true, skipped: true };
  const occurredAt = input.approval.resolvedAt || new Date().toISOString();
  const eventId = `evt_${randomUUID()}`;
  const event = {
    specVersion: CROSS_PRODUCT_SPEC_VERSION,
    eventId,
    eventType: "authority.decision.recorded.v1",
    occurredAt,
    expiresAt: snapshot.authorization.validUntil,
    producer: {
      system: "staffpass",
      kind: "authorization_authority",
      environment: integration.environment,
      tenantId: input.approval.orgId,
    },
    correlation: {
      jobId: input.approval.jobId,
      approvalRef: { system: "staffpass", id: input.approval.id, version: 1 },
    },
    aggregate: { type: "authority_decision", id: input.approval.id, version: 1 },
    data: {
      authorityMode: "external_reference",
      decisionId: input.approval.id,
      decisionVersion: 1,
      decision: input.decision === "approved" ? "approved" : "denied",
      actor: {
        organizationId: input.approval.orgId,
        employeeId: input.approval.employeeId,
        credentialId: input.approval.credentialId,
        credentialGeneration: snapshot.credentialGeneration,
      },
      authorization: {
        purpose: input.approval.purpose,
        currency: snapshot.authorization.currency,
        maxAmount: snapshot.authorization.maxAmount,
        merchantPolicy: snapshot.authorization.merchantPolicy,
        ...(snapshot.authorization.skuPolicy
          ? { skuPolicy: snapshot.authorization.skuPolicy }
          : {}),
        ...(snapshot.authorization.quoteHash
          ? { quoteHash: snapshot.authorization.quoteHash }
          : {}),
        approvalRequired: true,
        approvedByReference: `member_${createHash("sha256")
          .update(input.actorEmail.toLowerCase())
          .digest("hex")
          .slice(0, 24)}`,
        validUntil: snapshot.authorization.validUntil,
      },
    },
  };
  const rawBody = JSON.stringify(event);
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, eventId, error: "supabase_not_configured" };
  const outboxId = createHash("sha256")
    .update(`staffpass:${integration.environment}:${eventId}`)
    .digest("hex");
  const queued = await admin.from("cross_product_event_outbox").upsert({
    id: outboxId,
    org_id: input.approval.orgId,
    event_id: eventId,
    event_type: event.eventType,
    body_hash: bodyHash,
    raw_event: event,
    raw_body: rawBody,
    status: "pending",
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
  });
  if (queued.error) return { ok: false, eventId, error: "event_outbox_write_failed" };
  return deliverOutboxRow(
    { id: outboxId, event_id: eventId, body_hash: bodyHash, raw_body: rawBody, attempts: 0 },
    integration,
    admin,
  );
}

export async function dispatchAuthorityEventOutbox(limit = 20) {
  const integration = config();
  if (!integration) return { skipped: true as const, selected: 0, delivered: 0, failed: 0 };
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("cross_product_event_outbox")
    .select("id,event_id,body_hash,raw_body,attempts")
    .in("status", ["pending", "retryable"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error("authority_outbox_query_failed");
  const results = [];
  for (const row of (data ?? []) as AuthorityOutboxRow[]) {
    results.push(await deliverOutboxRow(row, integration, admin));
  }
  return {
    skipped: false as const,
    selected: results.length,
    delivered: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
  };
}
