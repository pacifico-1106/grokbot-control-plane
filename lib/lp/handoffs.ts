/**
 * LP Handoffs data layer.
 * Handles transfer from AI chat to human consultation.
 * 
 * Feature flag: LP_HANDOFF_ENABLED (default OFF)
 */

import { createSupabaseAdminClient } from "@/lib/supabase";
import { isLpHandoffEnabled } from "@/lib/feature-flags";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export type HandoffStatus = 
  | "pending_confirmation"
  | "confirmed"
  | "sent_to_outbox"
  | "delivered"
  | "cancelled";

export interface Handoff {
  id: string;
  tenantId: string;
  journeyId: string;
  reason: string;
  summaryDraft: string;
  summaryFinal: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactNotes: string | null;
  status: HandoffStatus;
  confirmedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateHandoffInput {
  journeyId: string;
  reason: string;
  summaryDraft: string;
  ipHash?: string;
  userAgentHash?: string;
}

export interface ConfirmHandoffInput {
  handoffId: string;
  summaryFinal: string;
  contactEmail?: string;
  contactPhone?: string;
  contactNotes?: string;
}

function mapHandoffRow(row: Record<string, unknown>): Handoff {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    journeyId: String(row.journey_id),
    reason: String(row.reason),
    summaryDraft: String(row.summary_draft),
    summaryFinal: row.summary_final ? String(row.summary_final) : null,
    contactEmail: row.contact_email ? String(row.contact_email) : null,
    contactPhone: row.contact_phone ? String(row.contact_phone) : null,
    contactNotes: row.contact_notes ? String(row.contact_notes) : null,
    status: String(row.status) as HandoffStatus,
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
    deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function createHandoff(input: CreateHandoffInput): Promise<Handoff | null> {
  if (!isLpHandoffEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[handoffs] Supabase admin client not configured");
    return null;
  }

  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("lp_handoffs")
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      journey_id: input.journeyId,
      reason: input.reason,
      summary_draft: input.summaryDraft.slice(0, 2000),
      status: "pending_confirmation",
      ip_hash: input.ipHash || null,
      user_agent_hash: input.userAgentHash || null,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[handoffs] Failed to create handoff:", error);
    return null;
  }

  return mapHandoffRow(data as Record<string, unknown>);
}

export async function getHandoff(handoffId: string): Promise<Handoff | null> {
  if (!isLpHandoffEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data } = await admin
    .from("lp_handoffs")
    .select("*")
    .eq("id", handoffId)
    .maybeSingle();

  if (!data) {
    return null;
  }

  return mapHandoffRow(data as Record<string, unknown>);
}

export async function getHandoffByJourney(journeyId: string): Promise<Handoff | null> {
  if (!isLpHandoffEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data } = await admin
    .from("lp_handoffs")
    .select("*")
    .eq("journey_id", journeyId)
    .eq("status", "pending_confirmation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    return null;
  }

  return mapHandoffRow(data as Record<string, unknown>);
}

export async function confirmHandoff(input: ConfirmHandoffInput): Promise<Handoff | null> {
  if (!isLpHandoffEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("lp_handoffs")
    .update({
      summary_final: input.summaryFinal.slice(0, 2000),
      contact_email: input.contactEmail?.slice(0, 320) || null,
      contact_phone: input.contactPhone?.slice(0, 50) || null,
      contact_notes: input.contactNotes?.slice(0, 500) || null,
      status: "confirmed",
      confirmed_at: now,
      updated_at: now,
    })
    .eq("id", input.handoffId)
    .eq("status", "pending_confirmation")
    .select("*")
    .single();

  if (error || !data) {
    console.error("[handoffs] Failed to confirm handoff:", error);
    return null;
  }

  return mapHandoffRow(data as Record<string, unknown>);
}

export async function cancelHandoff(handoffId: string): Promise<boolean> {
  if (!isLpHandoffEnabled()) {
    return false;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const { error } = await admin
    .from("lp_handoffs")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", handoffId)
    .eq("status", "pending_confirmation");

  return !error;
}

export async function updateHandoffStatus(
  handoffId: string, 
  status: HandoffStatus
): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (status === "delivered") {
    updates.delivered_at = new Date().toISOString();
  }

  const { error } = await admin
    .from("lp_handoffs")
    .update(updates)
    .eq("id", handoffId);

  return !error;
}

export async function getConfirmedHandoffsForOutbox(limit: number = 10): Promise<Handoff[]> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return [];
  }

  const { data } = await admin
    .from("lp_handoffs")
    .select("*")
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: true })
    .limit(limit);

  if (!data) {
    return [];
  }

  return data.map((row) => mapHandoffRow(row as Record<string, unknown>));
}
