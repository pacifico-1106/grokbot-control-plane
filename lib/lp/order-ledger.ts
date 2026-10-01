/**
 * LP Order Ledger data layer.
 * Feature flag LP_ORDER_LEDGER_ENABLED must be ON.
 */

import { createHash } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isLpOrderLedgerEnabled } from "@/lib/feature-flags";

export type PaymentStatus = "not_started" | "pending" | "paid" | "failed" | "refunded";
export type ContractStatus = "not_accepted" | "terms_accepted" | "concluded" | "cancelled";
export type ServiceStatus = "not_started" | "scheduled" | "provisioning" | "active" | "suspended" | "ended";
export type OrderStatus = 
  | "draft" 
  | "application_submitted" 
  | "checkout_pending"
  | "payment_pending" 
  | "setup_paid" 
  | "provisioning"
  | "active" 
  | "payment_failed" 
  | "paid_provisioning_failed"
  | "cancelled" 
  | "review_required";

export type CheckoutAttemptStatus = "created" | "pending" | "complete" | "expired" | "failed";
export type StripeEventStatus = "pending" | "processing" | "processed" | "failed" | "ignored";

export interface Order {
  id: string;
  tenantId: string;
  inquiryId: string | null;
  journeyId: string | null;
  email: string;
  currentRevision: number;
  catalogVersionId: string | null;
  paymentStatus: PaymentStatus;
  contractStatus: ContractStatus;
  serviceStatus: ServiceStatus;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OrderRevision {
  id: string;
  orderId: string;
  tenantId: string;
  revision: number;
  snapshot: Record<string, unknown>;
  snapshotHash: string;
  termsVersion: string;
  acceptedAt: string | null;
  acceptanceEventId: string | null;
  createdAt: string;
}

export interface CheckoutAttempt {
  id: string;
  orderId: string;
  tenantId: string;
  revision: number;
  attemptNumber: number;
  stripeSessionId: string | null;
  stripeMode: "payment" | "subscription" | "setup";
  status: CheckoutAttemptStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface StripeEventInbox {
  id: string;
  environment: "test" | "live";
  accountId: string;
  eventId: string;
  eventType: string;
  objectId: string;
  status: StripeEventStatus;
  payloadHash: string | null;
  receivedAt: string;
  processedAt: string | null;
  error: string | null;
}

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

function hashSnapshot(snapshot: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function mapOrderRow(row: Record<string, unknown>): Order {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    inquiryId: row.inquiry_id ? String(row.inquiry_id) : null,
    journeyId: row.journey_id ? String(row.journey_id) : null,
    email: String(row.email),
    currentRevision: Number(row.current_revision ?? 1),
    catalogVersionId: row.catalog_version_id ? String(row.catalog_version_id) : null,
    paymentStatus: (row.payment_status as PaymentStatus) ?? "not_started",
    contractStatus: (row.contract_status as ContractStatus) ?? "not_accepted",
    serviceStatus: (row.service_status as ServiceStatus) ?? "not_started",
    status: (row.status as OrderStatus) ?? "draft",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCheckoutAttemptRow(row: Record<string, unknown>): CheckoutAttempt {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    revision: Number(row.revision),
    attemptNumber: Number(row.attempt_number),
    stripeSessionId: row.stripe_session_id ? String(row.stripe_session_id) : null,
    stripeMode: (row.stripe_mode as "payment" | "subscription" | "setup") ?? "payment",
    status: (row.status as CheckoutAttemptStatus) ?? "created",
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

export async function createOrder(input: {
  email: string;
  sku: string;
  catalogVersionKey: string;
  snapshot: Record<string, unknown>;
  termsVersion: string;
  inquiryId?: string;
  journeyId?: string;
}): Promise<Order | null> {
  if (!isLpOrderLedgerEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[order-ledger] Supabase admin client not configured");
    return null;
  }

  const now = new Date().toISOString();
  const snapshotHash = hashSnapshot(input.snapshot);

  const { data: versionData } = await admin
    .from("lp_catalog_versions")
    .select("id")
    .eq("version_key", input.catalogVersionKey)
    .maybeSingle();

  const catalogVersionId = versionData?.id || null;

  const { data: orderData, error: orderError } = await admin
    .from("lp_orders")
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      email: input.email,
      inquiry_id: input.inquiryId || null,
      journey_id: input.journeyId || null,
      current_revision: 1,
      catalog_version_id: catalogVersionId,
      payment_status: "not_started",
      contract_status: "not_accepted",
      service_status: "not_started",
      status: "draft",
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (orderError || !orderData) {
    console.error("[order-ledger] Order creation failed:", orderError);
    throw new Error(orderError?.message || "order_create_failed");
  }

  const order = mapOrderRow(orderData as Record<string, unknown>);

  const { error: revisionError } = await admin
    .from("lp_order_revisions")
    .insert({
      order_id: order.id,
      tenant_id: DEFAULT_TENANT_ID,
      revision: 1,
      snapshot: input.snapshot,
      snapshot_hash: snapshotHash,
      terms_version: input.termsVersion,
      created_at: now,
    });

  if (revisionError) {
    console.error("[order-ledger] Revision creation failed:", revisionError);
  }

  return order;
}

export async function createCheckoutAttempt(input: {
  orderId: string;
  revision: number;
  stripeMode?: "payment" | "subscription" | "setup";
}): Promise<CheckoutAttempt | null> {
  if (!isLpOrderLedgerEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { count } = await admin
    .from("lp_checkout_attempts")
    .select("*", { count: "exact", head: true })
    .eq("order_id", input.orderId)
    .eq("revision", input.revision);

  const attemptNumber = (count || 0) + 1;

  const { data, error } = await admin
    .from("lp_checkout_attempts")
    .insert({
      order_id: input.orderId,
      tenant_id: DEFAULT_TENANT_ID,
      revision: input.revision,
      attempt_number: attemptNumber,
      stripe_mode: input.stripeMode || "payment",
      status: "created",
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[order-ledger] Checkout attempt creation failed:", error);
    return null;
  }

  return mapCheckoutAttemptRow(data as Record<string, unknown>);
}

export async function updateCheckoutAttemptStatus(
  attemptId: string,
  status: CheckoutAttemptStatus,
  stripeSessionId?: string
): Promise<boolean> {
  if (!isLpOrderLedgerEnabled()) {
    return false;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const updates: Record<string, unknown> = { status };
  
  if (stripeSessionId) {
    updates.stripe_session_id = stripeSessionId;
  }
  
  if (status === "complete" || status === "failed" || status === "expired") {
    updates.completed_at = new Date().toISOString();
  }

  const { error } = await admin
    .from("lp_checkout_attempts")
    .update(updates)
    .eq("id", attemptId);

  if (error) {
    console.error("[order-ledger] Checkout attempt update failed:", error);
    return false;
  }

  return true;
}

export async function recordStripeEvent(input: {
  environment: "test" | "live";
  accountId: string;
  eventId: string;
  eventType: string;
  objectId: string;
  payloadHash?: string;
}): Promise<StripeEventInbox | null> {
  if (!isLpOrderLedgerEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data: existing } = await admin
    .from("lp_stripe_event_inbox")
    .select("*")
    .eq("environment", input.environment)
    .eq("account_id", input.accountId)
    .eq("event_id", input.eventId)
    .maybeSingle();

  if (existing) {
    return existing as StripeEventInbox;
  }

  const { data, error } = await admin
    .from("lp_stripe_event_inbox")
    .insert({
      environment: input.environment,
      account_id: input.accountId,
      event_id: input.eventId,
      event_type: input.eventType,
      object_id: input.objectId,
      payload_hash: input.payloadHash || null,
      status: "pending",
      received_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: duplicate } = await admin
        .from("lp_stripe_event_inbox")
        .select("*")
        .eq("environment", input.environment)
        .eq("account_id", input.accountId)
        .eq("event_id", input.eventId)
        .single();
      return duplicate as StripeEventInbox;
    }
    console.error("[order-ledger] Event recording failed:", error);
    return null;
  }

  return data as StripeEventInbox;
}

export async function updateOrderPaymentStatus(
  orderId: string,
  paymentStatus: PaymentStatus,
  overallStatus?: OrderStatus
): Promise<boolean> {
  if (!isLpOrderLedgerEnabled()) {
    return false;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const updates: Record<string, unknown> = {
    payment_status: paymentStatus,
    updated_at: new Date().toISOString(),
  };

  if (overallStatus) {
    updates.status = overallStatus;
  }

  const { error } = await admin
    .from("lp_orders")
    .update(updates)
    .eq("id", orderId);

  if (error) {
    console.error("[order-ledger] Order payment status update failed:", error);
    return false;
  }

  return true;
}

export async function getOrderByStripeSessionId(sessionId: string): Promise<Order | null> {
  if (!isLpOrderLedgerEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data: attemptData } = await admin
    .from("lp_checkout_attempts")
    .select("order_id")
    .eq("stripe_session_id", sessionId)
    .maybeSingle();

  if (!attemptData?.order_id) {
    return null;
  }

  const { data: orderData } = await admin
    .from("lp_orders")
    .select("*")
    .eq("id", attemptData.order_id)
    .single();

  if (!orderData) {
    return null;
  }

  return mapOrderRow(orderData as Record<string, unknown>);
}
