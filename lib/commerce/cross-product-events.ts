import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CommerceAuthorizationInput } from "@/lib/types";

export const CROSS_PRODUCT_SPEC_VERSION =
  "sealith.cross-product-commerce-events.v1" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,35})(?:\.[0-9]{1,18})?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH = /^0x[a-fA-F0-9]{64}$/;

export type CommerceAuthorizationSnapshot = {
  targetSystem: "sealith";
  authorityMode: "external_reference";
  currency: "JPYC";
  maxAmount: string;
  merchantPolicy: {
    allowedMerchantIds: string[];
    requiredSellerOfRecord: string;
  };
  skuPolicy?: { allowedSkuIds: string[] };
  quoteHash?: string;
  approvalRequired: true;
  validUntil: string;
};

export type CommerceProjectionEvent = {
  specVersion: typeof CROSS_PRODUCT_SPEC_VERSION;
  eventId: string;
  eventType:
    | "commerce.order.linked.v1"
    | "commerce.payment.status_changed.v1"
    | "commerce.fulfillment.status_changed.v1"
    | "commerce.reversal.status_changed.v1";
  occurredAt: string;
  expiresAt?: string;
  producer: {
    system: "sealith";
    kind: "commerce_ledger";
    environment: "staging" | "production";
    tenantId: string;
  };
  correlation: {
    jobId: string;
    approvalRef?: { system: string; id: string; version: number };
    orderId: string;
  };
  aggregate: { type: string; id: string; version: number };
  data: Record<string, unknown> & { orderId: string };
};

export class CrossProductEventError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new CrossProductEventError(`invalid_${field}`, 400);
  }
  return value;
}

function identifiers(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new CrossProductEventError(`invalid_${field}`, 400);
  }
  const normalized = value.map((item) => identifier(item, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new CrossProductEventError(`invalid_${field}`, 400);
  }
  return normalized;
}

export function normalizeCommerceAuthorization(input: {
  value: CommerceAuthorizationInput;
  purpose: string;
  amountJpy: number;
  now?: Date;
}): CommerceAuthorizationSnapshot {
  const value = input.value;
  if (
    value.targetSystem !== "sealith" ||
    value.currency !== "JPYC" ||
    typeof value.maxAmount !== "string" ||
    !AMOUNT.test(value.maxAmount) ||
    !Number.isFinite(input.amountJpy) ||
    input.amountJpy < 0 ||
    Number(value.maxAmount) < input.amountJpy
  ) {
    throw new CrossProductEventError("invalid_commerce_authorization", 400);
  }
  const validUntilMs = Date.parse(value.validUntil);
  if (!Number.isFinite(validUntilMs) || validUntilMs <= (input.now ?? new Date()).getTime()) {
    throw new CrossProductEventError("commerce_authorization_expired", 400);
  }
  const skuPolicy = value.skuPolicy
    ? { allowedSkuIds: identifiers(value.skuPolicy.allowedSkuIds, "sku_policy", 100) }
    : undefined;
  const quoteHash = value.quoteHash?.toLowerCase();
  if (!skuPolicy && !quoteHash) {
    throw new CrossProductEventError("sku_or_quote_binding_required", 400);
  }
  if (quoteHash && !SHA256.test(quoteHash)) {
    throw new CrossProductEventError("invalid_quote_hash", 400);
  }
  return {
    targetSystem: "sealith",
    authorityMode: "external_reference",
    currency: "JPYC",
    maxAmount: value.maxAmount,
    merchantPolicy: {
      allowedMerchantIds: identifiers(
        value.merchantPolicy?.allowedMerchantIds,
        "merchant_policy",
        50,
      ),
      requiredSellerOfRecord: identifier(
        value.merchantPolicy?.requiredSellerOfRecord,
        "seller_of_record",
      ),
    },
    ...(skuPolicy ? { skuPolicy } : {}),
    ...(quoteHash ? { quoteHash } : {}),
    approvalRequired: true,
    validUntil: new Date(validUntilMs).toISOString(),
  };
}

export function eventBodyHash(rawBody: string) {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export function signCrossProductEvent(
  rawBody: string,
  timestamp: string,
  secret: string,
) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
}

export function verifyCrossProductRequest(input: {
  rawBody: string;
  eventIdHeader: string | null;
  timestampHeader: string | null;
  signatureHeader: string | null;
  secret: string;
  now?: Date;
  maxSkewSeconds?: number;
}) {
  if (input.secret.length < 32) {
    throw new CrossProductEventError("event_secret_not_configured", 503);
  }
  const timestamp = input.timestampHeader ?? "";
  if (!/^\d{10}$/.test(timestamp)) {
    throw new CrossProductEventError("invalid_event_timestamp", 401);
  }
  const now = input.now ?? new Date();
  if (
    Math.abs(Math.floor(now.getTime() / 1_000) - Number(timestamp)) >
    (input.maxSkewSeconds ?? 300)
  ) {
    throw new CrossProductEventError("event_timestamp_outside_window", 401);
  }
  const supplied = input.signatureHeader?.match(/^v1=([a-f0-9]{64})$/)?.[1];
  if (!supplied) throw new CrossProductEventError("invalid_event_signature", 401);
  const expected = signCrossProductEvent(input.rawBody, timestamp, input.secret);
  if (
    !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))
  ) {
    throw new CrossProductEventError("invalid_event_signature", 401);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw new CrossProductEventError("invalid_event_json", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CrossProductEventError("invalid_event_json", 400);
  }
  const record = parsed as Record<string, unknown>;
  if (record.eventId !== input.eventIdHeader) {
    throw new CrossProductEventError("event_id_header_mismatch", 400);
  }
  if (typeof record.expiresAt === "string" && Date.parse(record.expiresAt) <= now.getTime()) {
    throw new CrossProductEventError("event_expired", 410);
  }
  return { parsed, bodyHash: eventBodyHash(input.rawBody), timestamp };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CrossProductEventError(`invalid_${field}`, 400);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new CrossProductEventError(`unknown_${field}_field`, 400);
  }
}

function dateTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new CrossProductEventError(`invalid_${field}`, 400);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new CrossProductEventError(`invalid_${field}`, 400);
  }
  return Number(value);
}

function optionalIdentifier(value: unknown, field: string) {
  if (value !== undefined) identifier(value, field);
}

export function parseCommerceProjectionEvent(value: unknown): CommerceProjectionEvent {
  const event = record(value, "event");
  onlyKeys(
    event,
    [
      "specVersion",
      "eventId",
      "eventType",
      "occurredAt",
      "expiresAt",
      "producer",
      "correlation",
      "aggregate",
      "data",
    ],
    "event",
  );
  if (event.specVersion !== CROSS_PRODUCT_SPEC_VERSION) {
    throw new CrossProductEventError("unsupported_spec_version", 400);
  }
  const eventType = event.eventType;
  const allowed = new Set([
    "commerce.order.linked.v1",
    "commerce.payment.status_changed.v1",
    "commerce.fulfillment.status_changed.v1",
    "commerce.reversal.status_changed.v1",
  ]);
  if (typeof eventType !== "string" || !allowed.has(eventType)) {
    throw new CrossProductEventError("unsupported_event_type", 400);
  }
  identifier(event.eventId, "event_id");
  dateTime(event.occurredAt, "occurred_at");
  if (event.expiresAt !== undefined) dateTime(event.expiresAt, "expires_at");
  const producer = record(event.producer, "producer");
  onlyKeys(producer, ["system", "kind", "environment", "tenantId"], "producer");
  if (producer.system !== "sealith" || producer.kind !== "commerce_ledger") {
    throw new CrossProductEventError("invalid_commerce_producer", 403);
  }
  if (producer.environment !== "staging" && producer.environment !== "production") {
    throw new CrossProductEventError("invalid_event_environment", 400);
  }
  identifier(producer.tenantId, "producer_tenant_id");
  const correlation = record(event.correlation, "correlation");
  onlyKeys(correlation, ["jobId", "approvalRef", "orderId"], "correlation");
  identifier(correlation.jobId, "job_id");
  if (correlation.approvalRef !== undefined) {
    const approvalRef = record(correlation.approvalRef, "approval_ref");
    onlyKeys(approvalRef, ["system", "id", "version"], "approval_ref");
    identifier(approvalRef.system, "approval_system");
    identifier(approvalRef.id, "approval_id");
    positiveInteger(approvalRef.version, "approval_version");
  }
  const aggregate = record(event.aggregate, "aggregate");
  onlyKeys(aggregate, ["type", "id", "version"], "aggregate");
  identifier(aggregate.type, "aggregate_type");
  const data = record(event.data, "data");
  const orderId = identifier(correlation.orderId, "order_id");
  if (
    identifier(data.orderId, "order_id") !== orderId ||
    identifier(aggregate.id, "aggregate_id") !== orderId ||
    positiveInteger(aggregate.version, "aggregate_version") < 1
  ) {
    throw new CrossProductEventError("commerce_correlation_mismatch", 400);
  }
  if (eventType === "commerce.order.linked.v1") {
    onlyKeys(
      data,
      [
        "orderId",
        "orderStatus",
        "authorityMode",
        "merchantId",
        "sellerOfRecord",
        "skuId",
        "currency",
        "amount",
        "approvalValidation",
      ],
      "order_data",
    );
    identifier(data.orderStatus, "order_status");
    if (
      !["sealith_native", "external_reference", "external_trusted"].includes(
        String(data.authorityMode),
      ) ||
      data.currency !== "JPYC" ||
      typeof data.amount !== "string" ||
      !AMOUNT.test(data.amount)
    ) {
      throw new CrossProductEventError("invalid_order_data", 400);
    }
    identifier(data.merchantId, "merchant_id");
    identifier(data.sellerOfRecord, "seller_of_record");
    identifier(data.skuId, "sku_id");
    const approvalValidation = record(data.approvalValidation, "approval_validation");
    onlyKeys(
      approvalValidation,
      ["disposition", "reasonCode", "sourceEventId"],
      "approval_validation",
    );
    if (
      !["not_present", "reference_only", "accepted", "rejected"].includes(
        String(approvalValidation.disposition),
      )
    ) {
      throw new CrossProductEventError("invalid_approval_validation", 400);
    }
    optionalIdentifier(approvalValidation.reasonCode, "approval_reason_code");
    optionalIdentifier(approvalValidation.sourceEventId, "approval_source_event_id");
  } else if (eventType === "commerce.payment.status_changed.v1") {
    onlyKeys(
      data,
      ["orderId", "paymentEventId", "status", "transfer", "reasonCode"],
      "payment_data",
    );
    const status = data.status;
    if (!["pending", "observed", "confirmed", "failed", "expired", "refunded"].includes(String(status))) {
      throw new CrossProductEventError("invalid_payment_status", 400);
    }
    if (status === "confirmed") {
      const transfer = record(data.transfer, "transfer");
      onlyKeys(
        transfer,
        [
          "chainId",
          "tokenContract",
          "transactionHash",
          "logIndex",
          "fromAddress",
          "toAddress",
          "amountAtomic",
        ],
        "transfer",
      );
      if (
        !identifier(data.paymentEventId, "payment_event_id") ||
        !Number.isInteger(transfer.chainId) ||
        Number(transfer.chainId) < 1 ||
        typeof transfer.tokenContract !== "string" ||
        !EVM_ADDRESS.test(transfer.tokenContract) ||
        typeof transfer.transactionHash !== "string" ||
        !TX_HASH.test(transfer.transactionHash) ||
        !Number.isInteger(transfer.logIndex) ||
        Number(transfer.logIndex) < 0
      ) {
        throw new CrossProductEventError("confirmed_transfer_required", 400);
      }
      if (
        (transfer.fromAddress !== undefined &&
          (typeof transfer.fromAddress !== "string" ||
            !EVM_ADDRESS.test(transfer.fromAddress))) ||
        (transfer.toAddress !== undefined &&
          (typeof transfer.toAddress !== "string" ||
            !EVM_ADDRESS.test(transfer.toAddress))) ||
        (transfer.amountAtomic !== undefined &&
          (typeof transfer.amountAtomic !== "string" ||
            !/^[1-9][0-9]{0,77}$/.test(transfer.amountAtomic)))
      ) {
        throw new CrossProductEventError("invalid_transfer_evidence", 400);
      }
    }
    optionalIdentifier(data.paymentEventId, "payment_event_id");
    optionalIdentifier(data.reasonCode, "payment_reason_code");
  } else if (eventType === "commerce.fulfillment.status_changed.v1") {
    onlyKeys(
      data,
      ["orderId", "status", "providerReference", "reasonCode"],
      "fulfillment_data",
    );
    if (
      !["pending", "holding", "fulfilling", "completed", "failed", "released"].includes(
        String(data.status),
      )
    ) {
      throw new CrossProductEventError("invalid_fulfillment_status", 400);
    }
    optionalIdentifier(data.providerReference, "provider_reference");
    optionalIdentifier(data.reasonCode, "fulfillment_reason_code");
  } else {
    onlyKeys(
      data,
      ["orderId", "refundCaseId", "status", "reasonCode"],
      "reversal_data",
    );
    if (
      ![
        "not_requested",
        "pending_manual_review",
        "requested",
        "processing",
        "completed",
        "failed",
      ].includes(String(data.status))
    ) {
      throw new CrossProductEventError("invalid_reversal_status", 400);
    }
    optionalIdentifier(data.refundCaseId, "refund_case_id");
    optionalIdentifier(data.reasonCode, "reversal_reason_code");
  }
  return event as unknown as CommerceProjectionEvent;
}

export function parseTenantMap(raw: string | undefined) {
  if (!raw?.trim()) return new Map<string, string>();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CrossProductEventError("invalid_tenant_map", 503);
  }
  const map = record(value, "tenant_map");
  const result = new Map<string, string>();
  for (const [staffpassOrgId, sealithOrgId] of Object.entries(map)) {
    result.set(identifier(staffpassOrgId, "staffpass_org_id"), identifier(sealithOrgId, "sealith_org_id"));
  }
  return result;
}

export function resolveStaffpassTenant(
  tenantMap: Map<string, string>,
  sealithOrgId: string,
) {
  const staffpassOrgId = Array.from(tenantMap.entries()).find(
    ([, mappedSealithOrgId]) => mappedSealithOrgId === sealithOrgId,
  )?.[0];
  if (!staffpassOrgId) {
    throw new CrossProductEventError("sealith_tenant_not_mapped", 403);
  }
  return staffpassOrgId;
}

export function classifyInboxReplay(input: {
  existingBodyHash?: string | null;
  existingVersion?: number | null;
  bodyHash: string;
  incomingVersion: number;
}) {
  if (input.existingBodyHash) {
    if (input.existingBodyHash === input.bodyHash) return "duplicate" as const;
    throw new CrossProductEventError("event_id_body_conflict", 409);
  }
  if (
    Number.isInteger(input.existingVersion) &&
    input.incomingVersion <= Number(input.existingVersion)
  ) {
    return "stale" as const;
  }
  return "accept" as const;
}
