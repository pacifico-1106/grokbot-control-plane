/**
 * LP Outbox Processor
 * Processes notification_outbox entries for LP module.
 * Uses business_key for idempotency.
 * 
 * This module processes handoff notifications and sends them
 * to the configured notification channels.
 */

import { createSupabaseAdminClient } from "@/lib/supabase";
import { updateHandoffStatus, type Handoff } from "./handoffs";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const MAX_RETRIES = 3;

export interface OutboxEntry {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  businessKey: string;
  status: "pending" | "processing" | "delivered" | "failed";
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function mapOutboxRow(row: Record<string, unknown>): OutboxEntry {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    type: String(row.type),
    payload: (row.payload as Record<string, unknown>) || {},
    businessKey: String(row.business_key),
    status: String(row.status) as OutboxEntry["status"],
    attempts: Number(row.attempts ?? 0),
    lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at),
  };
}

export async function enqueueHandoffNotification(handoff: Handoff): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[outbox] Supabase admin client not configured");
    return null;
  }

  const businessKey = `handoff:${handoff.id}`;
  const now = new Date().toISOString();

  const payload = {
    handoffId: handoff.id,
    journeyId: handoff.journeyId,
    reason: handoff.reason,
    summary: handoff.summaryFinal || handoff.summaryDraft,
    contactEmail: handoff.contactEmail,
    contactPhone: handoff.contactPhone,
    contactNotes: handoff.contactNotes,
    confirmedAt: handoff.confirmedAt,
  };

  const { data, error } = await admin
    .from("notification_outbox")
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      type: "lp_handoff",
      payload,
      business_key: businessKey,
      status: "pending",
      attempts: 0,
      created_at: now,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      console.log("[outbox] Duplicate entry for business_key:", businessKey);
      return null;
    }
    console.error("[outbox] Failed to enqueue notification:", error);
    return null;
  }

  await updateHandoffStatus(handoff.id, "sent_to_outbox");
  return data?.id || null;
}

export async function getPendingOutboxEntries(
  type: string,
  limit: number = 10
): Promise<OutboxEntry[]> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return [];
  }

  const { data } = await admin
    .from("notification_outbox")
    .select("*")
    .eq("type", type)
    .eq("status", "pending")
    .lt("attempts", MAX_RETRIES)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (!data) {
    return [];
  }

  return data.map((row) => mapOutboxRow(row as Record<string, unknown>));
}

export async function markOutboxProcessing(entryId: string): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const { error } = await admin
    .from("notification_outbox")
    .update({
      status: "processing",
      last_attempt_at: new Date().toISOString(),
    })
    .eq("id", entryId)
    .eq("status", "pending");

  return !error;
}

export async function markOutboxDelivered(entryId: string): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const { error } = await admin
    .from("notification_outbox")
    .update({
      status: "delivered",
      last_attempt_at: new Date().toISOString(),
    })
    .eq("id", entryId);

  return !error;
}

export async function markOutboxFailed(
  entryId: string,
  errorMessage: string,
  currentAttempts: number
): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const newStatus = currentAttempts + 1 >= MAX_RETRIES ? "failed" : "pending";

  const { error } = await admin
    .from("notification_outbox")
    .update({
      status: newStatus,
      attempts: currentAttempts + 1,
      last_attempt_at: new Date().toISOString(),
      last_error: errorMessage.slice(0, 1000),
    })
    .eq("id", entryId);

  return !error;
}

export interface ProcessResult {
  processed: number;
  delivered: number;
  failed: number;
  errors: string[];
}

export async function processHandoffOutbox(
  sendNotification: (entry: OutboxEntry) => Promise<{ success: boolean; error?: string }>
): Promise<ProcessResult> {
  const result: ProcessResult = {
    processed: 0,
    delivered: 0,
    failed: 0,
    errors: [],
  };

  const entries = await getPendingOutboxEntries("lp_handoff", 10);

  for (const entry of entries) {
    result.processed++;

    const claimed = await markOutboxProcessing(entry.id);
    if (!claimed) {
      continue;
    }

    try {
      const sendResult = await sendNotification(entry);

      if (sendResult.success) {
        await markOutboxDelivered(entry.id);
        
        const handoffId = entry.payload.handoffId as string;
        if (handoffId) {
          await updateHandoffStatus(handoffId, "delivered");
        }
        
        result.delivered++;
      } else {
        await markOutboxFailed(entry.id, sendResult.error || "unknown", entry.attempts);
        result.failed++;
        if (sendResult.error) {
          result.errors.push(`${entry.id}: ${sendResult.error}`);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "unknown error";
      await markOutboxFailed(entry.id, errorMsg, entry.attempts);
      result.failed++;
      result.errors.push(`${entry.id}: ${errorMsg}`);
    }
  }

  return result;
}
