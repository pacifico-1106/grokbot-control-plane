/**
 * Stripe webhook tenant guard (fail-closed).
 *
 * Invariant: a Stripe event may only change state for org X when
 *   - every org id claimed by the event (client_reference_id / metadata.orgId /
 *     metadata.org_id, on the event object and any retrieved subscription)
 *     is the same single org X, AND
 *   - the event's Stripe Customer ID is stored on exactly one org
 *     (orgs.stripe_customer_id) and that org is X.
 *
 * Metadata alone is never trusted to pick the tenant. On any mismatch the
 * caller must not write and should record the rejection
 * (recordStripeTenantMismatch) and acknowledge with 2xx (permanent).
 * Lookup errors are thrown so the caller can return 5xx (transient).
 */

import { appendAuditEvent } from "@/lib/data/audit";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export type TenantMismatchReason =
  | "metadata_org_missing"
  | "metadata_org_conflict"
  | "customer_missing"
  | "customer_conflict"
  | "customer_not_linked"
  | "customer_linked_to_multiple_orgs"
  | "customer_org_mismatch";

export type TenantCheckOk = { ok: true; orgId: string; customerId: string };
export type TenantCheckRejected = {
  ok: false;
  reason: TenantMismatchReason;
  claimedOrgIds: string[];
  customerIds: string[];
  linkedOrgIds: string[];
};
export type TenantCheck = TenantCheckOk | TenantCheckRejected;

/**
 * Returns org ids whose stored stripe_customer_id equals customerId.
 * null = no tenant DB (DEMO) → verification is skipped (DEMO never writes).
 * Throws on DB errors.
 */
export type LinkedOrgLookup = (customerId: string) => Promise<string[] | null>;

function distinct(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function customerIdOf(
  ref: string | { id?: string | null } | null | undefined
): string | null {
  if (!ref) return null;
  const raw = typeof ref === "string" ? ref : ref.id;
  const s = typeof raw === "string" ? raw.trim() : "";
  return s || null;
}

export async function verifyStripeCustomerOrg(
  input: {
    claimedOrgIds: Array<string | null | undefined>;
    customerIds: Array<string | null | undefined>;
  },
  lookup: LinkedOrgLookup
): Promise<TenantCheck> {
  const claimedOrgIds = distinct(input.claimedOrgIds);
  const customerIds = distinct(input.customerIds);
  const reject = (
    reason: TenantMismatchReason,
    linkedOrgIds: string[] = []
  ): TenantCheckRejected => ({
    ok: false,
    reason,
    claimedOrgIds,
    customerIds,
    linkedOrgIds,
  });

  if (claimedOrgIds.length === 0) return reject("metadata_org_missing");
  if (claimedOrgIds.length > 1) return reject("metadata_org_conflict");
  if (customerIds.length === 0) return reject("customer_missing");
  if (customerIds.length > 1) return reject("customer_conflict");

  const orgId = claimedOrgIds[0];
  const customerId = customerIds[0];
  const linked = await lookup(customerId);
  if (linked === null) {
    // DEMO / no tenant DB: nothing is persisted, nothing to verify against.
    return { ok: true, orgId, customerId };
  }
  const linkedOrgIds = distinct(linked);
  if (linkedOrgIds.length === 0) return reject("customer_not_linked");
  if (linkedOrgIds.length > 1) {
    return reject("customer_linked_to_multiple_orgs", linkedOrgIds);
  }
  if (linkedOrgIds[0] !== orgId) {
    return reject("customer_org_mismatch", linkedOrgIds);
  }
  return { ok: true, orgId, customerId };
}

/** Server-side lookup: orgs where stripe_customer_id = customerId. */
export function createSupabaseLinkedOrgLookup(): LinkedOrgLookup {
  return async (customerId: string) => {
    if (isDemoMode()) return null;
    const admin = createSupabaseAdminClient();
    if (!admin) throw new Error("supabase_not_configured");
    const { data, error } = await admin
      .from("orgs")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .limit(2);
    if (error) {
      throw new Error(`org_customer_lookup_failed: ${error.message}`);
    }
    return (data ?? []).map((row) => String((row as { id: unknown }).id));
  };
}

type AuditWriter = (
  event: Parameters<typeof appendAuditEvent>[0]
) => Promise<void>;

/**
 * Record a rejected (mismatched) webhook event in the existing audit_events
 * timeline. One row per affected org; each row only contains that org's own
 * identifiers (no cross-tenant leakage). Never throws.
 */
export async function recordStripeTenantMismatch(
  event: { id: string; type: string },
  check: TenantCheckRejected,
  writeAudit: AuditWriter = appendAuditEvent
): Promise<void> {
  const summary = `Stripe Webhook（${event.type}）を処理しませんでした: 組織と Stripe 顧客の照合に失敗（${check.reason}）`;
  const base = {
    employeeId: null,
    credentialId: null,
    action: "billing.updated" as const,
    purpose: "stripe_webhook.tenant_mismatch",
    summary,
  };
  const rows: Array<Parameters<AuditWriter>[0]> = [];
  for (const orgId of check.claimedOrgIds) {
    rows.push({
      ...base,
      orgId,
      metadata: {
        eventId: event.id,
        eventType: event.type,
        reason: check.reason,
        side: "metadata_org",
        customerLinkedToThisOrg: false,
      },
    });
  }
  for (const orgId of check.linkedOrgIds) {
    if (check.claimedOrgIds.includes(orgId)) continue;
    rows.push({
      ...base,
      orgId,
      metadata: {
        eventId: event.id,
        eventType: event.type,
        reason: check.reason,
        side: "customer_org",
        stripeCustomerId: check.customerIds[0] ?? null,
      },
    });
  }
  // Server log: ids only (no payload, no PII) for ops correlation.
  console.warn("[stripe:webhook] tenant_mismatch", {
    eventId: event.id,
    eventType: event.type,
    reason: check.reason,
    claimedOrgIds: check.claimedOrgIds,
    customerIds: check.customerIds,
    linkedOrgIds: check.linkedOrgIds,
  });
  for (const row of rows) {
    try {
      await writeAudit(row);
    } catch (e) {
      console.error("[stripe:webhook] tenant_mismatch audit write failed", {
        eventId: event.id,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }
}
