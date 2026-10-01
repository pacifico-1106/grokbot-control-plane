/**
 * P1 Plan Rails — Stripe webhook event idempotency layer.
 *
 * Provides exactly-once processing guarantee for Stripe webhooks by
 * tracking processed event.id values in stripe_processed_events table.
 *
 * FEATURE FLAG: P1_PLAN_RAILS_ENABLED must be ON for plan-related event
 * processing. When OFF, events are still tracked for idempotency but
 * plan changes are not applied.
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export interface ProcessedEventRecord {
  eventId: string;
  eventType: string;
  orgId: string | null;
  processedAt: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Check if a Stripe event has already been processed.
 * Returns true if the event.id exists in stripe_processed_events.
 *
 * DEMO mode: always returns false (no persistence).
 */
export async function isStripeEventProcessed(
  eventId: string
): Promise<boolean> {
  if (isDemoMode()) {
    return false;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.warn("[stripe-events] supabase not configured, treating as unprocessed");
    return false;
  }

  const { data, error } = await admin
    .from("stripe_processed_events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    console.error("[stripe-events] check error", { eventId, error: error.message });
    return false;
  }

  return data !== null;
}

/**
 * Mark a Stripe event as processed.
 * Inserts event.id into stripe_processed_events for deduplication.
 *
 * DEMO mode: no-op (no persistence).
 * Duplicate inserts are silently ignored (upsert).
 */
export async function markStripeEventProcessed(
  eventId: string,
  eventType: string,
  orgId?: string | null,
  metadata?: Record<string, unknown> | null
): Promise<void> {
  if (isDemoMode()) {
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.warn("[stripe-events] supabase not configured, skipping mark");
    return;
  }

  const { error } = await admin.from("stripe_processed_events").upsert(
    {
      event_id: eventId,
      event_type: eventType,
      org_id: orgId || null,
      processed_at: new Date().toISOString(),
      metadata: metadata || null,
    },
    { onConflict: "event_id", ignoreDuplicates: true }
  );

  if (error) {
    console.error("[stripe-events] mark error", { eventId, error: error.message });
  }
}

/**
 * Get processed event record by event.id.
 * Returns null if event has not been processed.
 *
 * DEMO mode: always returns null.
 */
export async function getProcessedEvent(
  eventId: string
): Promise<ProcessedEventRecord | null> {
  if (isDemoMode()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data, error } = await admin
    .from("stripe_processed_events")
    .select("*")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    eventId: data.event_id,
    eventType: data.event_type,
    orgId: data.org_id,
    processedAt: data.processed_at,
    metadata: data.metadata,
  };
}

/**
 * List processed events for an org, ordered by most recent first.
 * Used for audit and debugging.
 *
 * DEMO mode: returns empty array.
 */
export async function listProcessedEventsForOrg(
  orgId: string,
  limit = 100
): Promise<ProcessedEventRecord[]> {
  if (isDemoMode()) {
    return [];
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return [];
  }

  const { data, error } = await admin
    .from("stripe_processed_events")
    .select("*")
    .eq("org_id", orgId)
    .order("processed_at", { ascending: false })
    .limit(limit);

  if (error || !data) {
    return [];
  }

  return data.map((row) => ({
    eventId: row.event_id,
    eventType: row.event_type,
    orgId: row.org_id,
    processedAt: row.processed_at,
    metadata: row.metadata,
  }));
}
