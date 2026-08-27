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

function config() {
  if (process.env.STAFFPASS_SEALITH_EVENTS_ENABLED !== "true") return null;
  const environment = process.env.CROSS_PRODUCT_EVENT_ENVIRONMENT;
  const endpoint = process.env.SEALITH_AUTHORITY_EVENTS_URL;
  const secret = process.env.STAFFPASS_SEALITH_EVENT_SECRET ?? "";
  if (
    (environment !== "staging" && environment !== "production") ||
    !endpoint ||
    secret.length < 32
  ) {
    throw new Error("authority_event_config_invalid");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("authority_event_url_must_be_https");
  return { environment, endpoint: url.toString(), secret } as const;
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
    status: "pending",
    attempts: 0,
  });
  if (queued.error) return { ok: false, eventId, error: "event_outbox_write_failed" };
  const timestamp = String(Math.floor(Date.now() / 1_000));
  try {
    const response = await fetch(integration.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Staffpass-AuthorityEvent/1.0",
        "x-sealith-event-id": eventId,
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
    await admin
      .from("cross_product_event_outbox")
      .update({
        status: response.ok ? "delivered" : "retryable",
        attempts: 1,
        last_http_status: response.status,
        delivered_at: response.ok ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", outboxId);
    return { ok: response.ok, eventId, status: response.status };
  } catch (error) {
    await admin
      .from("cross_product_event_outbox")
      .update({
        status: "retryable",
        attempts: 1,
        last_error: error instanceof Error ? error.message.slice(0, 300) : "delivery_failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", outboxId);
    return { ok: false, eventId, status: null, error: "delivery_failed" };
  }
}
