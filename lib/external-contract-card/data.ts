/**
 * P1 External Contract Card Registration Data Access
 *
 * CRITICAL SECURITY CONSTRAINTS:
 * - NEVER store or log PAN, CVV, expiry, card_fingerprint
 * - Only token references (stripe_payment_method_id) are persisted
 * - Feature flag must be checked before any operation
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type {
  ExternalContractPaymentMethod,
  ExternalContractCardAuditEvent,
  CreatePaymentMethodInput,
  CompletePaymentMethodInput,
  RecordCardAuditInput,
  PaymentMethodSetupStatus,
} from "./types";

function mapPaymentMethodRow(
  row: Record<string, unknown>
): ExternalContractPaymentMethod {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    stripePaymentMethodId: row.stripe_payment_method_id
      ? String(row.stripe_payment_method_id)
      : null,
    setupStatus: String(row.setup_status) as PaymentMethodSetupStatus,
    setupCompletedAt: row.setup_completed_at
      ? String(row.setup_completed_at)
      : null,
    setupCompletedBy: row.setup_completed_by
      ? String(row.setup_completed_by)
      : null,
    setupApprovalId: row.setup_approval_id
      ? String(row.setup_approval_id)
      : null,
    stripeSetupIntentId: row.stripe_setup_intent_id
      ? String(row.stripe_setup_intent_id)
      : null,
    metadata: (row.metadata as Record<string, unknown>) || {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAuditEventRow(
  row: Record<string, unknown>
): ExternalContractCardAuditEvent {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    action: String(row.action) as ExternalContractCardAuditEvent["action"],
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    actorEmail: row.actor_email ? String(row.actor_email) : null,
    approvalId: row.approval_id ? String(row.approval_id) : null,
    stripeSessionId: row.stripe_session_id
      ? String(row.stripe_session_id)
      : null,
    outcome: row.outcome
      ? (String(row.outcome) as ExternalContractCardAuditEvent["outcome"])
      : null,
    metadata: (row.metadata as Record<string, unknown>) || {},
    createdAt: String(row.created_at),
  };
}

/**
 * Get the current payment method for an org.
 * Returns the most recent completed or pending record.
 */
export async function getOrgPaymentMethod(
  orgId: string
): Promise<ExternalContractPaymentMethod | null> {
  if (isDemoMode()) return null;

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("org_external_contract_payment_methods")
    .select("*")
    .eq("org_id", orgId)
    .in("setup_status", ["completed", "pending"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return mapPaymentMethodRow(data as Record<string, unknown>);
}

/**
 * Get payment method by SetupIntent ID (for webhook processing).
 */
export async function getPaymentMethodBySetupIntent(
  setupIntentId: string
): Promise<ExternalContractPaymentMethod | null> {
  if (isDemoMode()) return null;

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("org_external_contract_payment_methods")
    .select("*")
    .eq("stripe_setup_intent_id", setupIntentId)
    .maybeSingle();

  if (error || !data) return null;
  return mapPaymentMethodRow(data as Record<string, unknown>);
}

/**
 * Create a pending payment method record.
 * Called when minting a setup link (before Stripe Checkout).
 */
export async function createPendingPaymentMethod(
  input: CreatePaymentMethodInput
): Promise<ExternalContractPaymentMethod> {
  if (isDemoMode()) {
    return {
      id: `demo_pm_${Date.now()}`,
      orgId: input.orgId,
      stripePaymentMethodId: null,
      setupStatus: "pending",
      setupCompletedAt: null,
      setupCompletedBy: null,
      setupApprovalId: null,
      stripeSetupIntentId: input.stripeSetupIntentId || null,
      metadata: input.metadata || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    org_id: input.orgId,
    setup_status: "pending",
    stripe_setup_intent_id: input.stripeSetupIntentId || null,
    metadata: input.metadata || {},
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await admin
    .from("org_external_contract_payment_methods")
    .insert(row)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "payment_method_create_failed");
  }

  return mapPaymentMethodRow(data as Record<string, unknown>);
}

/**
 * Complete a payment method setup (webhook handler).
 * Updates status to completed and stores the payment method token.
 *
 * CRITICAL: Only stores stripe_payment_method_id (pm_xxx) — never raw card data.
 */
export async function completePaymentMethodSetup(
  input: CompletePaymentMethodInput
): Promise<ExternalContractPaymentMethod> {
  if (isDemoMode()) {
    return {
      id: `demo_pm_${Date.now()}`,
      orgId: input.orgId,
      stripePaymentMethodId: input.stripePaymentMethodId,
      setupStatus: "completed",
      setupCompletedAt: new Date().toISOString(),
      setupCompletedBy: input.setupCompletedBy || null,
      setupApprovalId: input.setupApprovalId,
      stripeSetupIntentId: input.stripeSetupIntentId,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("org_external_contract_payment_methods")
    .update({
      stripe_payment_method_id: input.stripePaymentMethodId,
      setup_status: "completed",
      setup_completed_at: now,
      setup_completed_by: input.setupCompletedBy || null,
      setup_approval_id: input.setupApprovalId,
      updated_at: now,
    })
    .eq("org_id", input.orgId)
    .eq("stripe_setup_intent_id", input.stripeSetupIntentId)
    .eq("setup_status", "pending")
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "payment_method_complete_failed");
  }

  return mapPaymentMethodRow(data as Record<string, unknown>);
}

/**
 * Mark a payment method setup as failed.
 */
export async function failPaymentMethodSetup(
  orgId: string,
  setupIntentId: string
): Promise<void> {
  if (isDemoMode()) return;

  const admin = createSupabaseAdminClient();
  if (!admin) return;

  await admin
    .from("org_external_contract_payment_methods")
    .update({
      setup_status: "failed",
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
    .eq("stripe_setup_intent_id", setupIntentId)
    .eq("setup_status", "pending");
}

/**
 * Mark a payment method as removed (via Customer Portal).
 */
export async function removePaymentMethod(orgId: string): Promise<void> {
  if (isDemoMode()) return;

  const admin = createSupabaseAdminClient();
  if (!admin) return;

  await admin
    .from("org_external_contract_payment_methods")
    .update({
      setup_status: "removed",
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
    .eq("setup_status", "completed");
}

/**
 * Record a card setup audit event.
 *
 * CRITICAL: metadata must NEVER contain PAN/CVV/expiry/fingerprint.
 * This is enforced by DB comments and application-layer validation.
 */
export async function recordCardAuditEvent(
  input: RecordCardAuditInput
): Promise<ExternalContractCardAuditEvent> {
  if (isDemoMode()) {
    return {
      id: `demo_audit_${Date.now()}`,
      orgId: input.orgId,
      action: input.action,
      actorUserId: input.actorUserId || null,
      actorEmail: input.actorEmail || null,
      approvalId: input.approvalId || null,
      stripeSessionId: input.stripeSessionId || null,
      outcome: input.outcome || null,
      metadata: input.metadata || {},
      createdAt: new Date().toISOString(),
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const row: Record<string, unknown> = {
    org_id: input.orgId,
    action: input.action,
    actor_user_id: input.actorUserId || null,
    actor_email: input.actorEmail || null,
    approval_id: input.approvalId || null,
    stripe_session_id: input.stripeSessionId || null,
    outcome: input.outcome || null,
    metadata: input.metadata || {},
    created_at: new Date().toISOString(),
  };

  const { data, error } = await admin
    .from("audit_external_contract_card_events")
    .insert(row)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "card_audit_event_create_failed");
  }

  return mapAuditEventRow(data as Record<string, unknown>);
}

/**
 * Get card audit events for an org (for audit log display).
 */
export async function getCardAuditEvents(
  orgId: string,
  limit: number = 50
): Promise<ExternalContractCardAuditEvent[]> {
  if (isDemoMode()) return [];

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from("audit_external_contract_card_events")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.map((row) => mapAuditEventRow(row as Record<string, unknown>));
}

/**
 * Check if a SetupIntent has already been processed (idempotency).
 */
export async function isSetupIntentProcessed(
  setupIntentId: string
): Promise<boolean> {
  if (isDemoMode()) return false;

  const admin = createSupabaseAdminClient();
  if (!admin) return false;

  const { data } = await admin
    .from("audit_external_contract_card_events")
    .select("id")
    .eq("stripe_session_id", setupIntentId)
    .in("action", ["setup_completed", "setup_failed"])
    .limit(1)
    .maybeSingle();

  return data !== null;
}
