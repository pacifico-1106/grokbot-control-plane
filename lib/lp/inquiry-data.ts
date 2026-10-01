/**
 * LP Inquiry data layer.
 * Feature flag LP_INQUIRY_DB_ENABLED must be ON.
 */

import { createSupabaseAdminClient } from "@/lib/supabase";
import { isLpInquiryDbEnabled } from "@/lib/feature-flags";

export type InquirySource = "form" | "chat_handoff";
export type InquiryPlan = "intern" | "proper" | "executive" | "custom" | "undecided";
export type BillingPreference = "monthly" | "annual";
export type InquiryStatus = "received" | "notified" | "contacted" | "closed";

export interface InquiryInput {
  source: InquirySource;
  plan: InquiryPlan;
  billingPreference: BillingPreference;
  company: string;
  contactName: string;
  email: string;
  phone?: string;
  headcount?: string;
  useCase: string;
  consentGiven: boolean;
  consentVersion?: string;
  handoffSummary?: string;
  journeyId?: string;
}

export interface Inquiry {
  id: string;
  tenantId: string;
  source: InquirySource;
  plan: InquiryPlan;
  billingPreference: BillingPreference;
  company: string;
  contactName: string;
  email: string;
  phone: string | null;
  headcount: string | null;
  useCase: string;
  consentGiven: boolean;
  consentVersion: string | null;
  consentAt: string | null;
  status: InquiryStatus;
  createdAt: string;
  retentionUntil: string;
  handoffSummary: string | null;
  journeyId: string | null;
}

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

function mapRow(row: Record<string, unknown>): Inquiry {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    source: row.source as InquirySource,
    plan: row.plan as InquiryPlan,
    billingPreference: (row.billing_preference as BillingPreference) ?? "monthly",
    company: String(row.company ?? ""),
    contactName: String(row.contact_name ?? ""),
    email: String(row.email ?? ""),
    phone: row.phone ? String(row.phone) : null,
    headcount: row.headcount ? String(row.headcount) : null,
    useCase: String(row.use_case ?? ""),
    consentGiven: Boolean(row.consent_given),
    consentVersion: row.consent_version ? String(row.consent_version) : null,
    consentAt: row.consent_at ? String(row.consent_at) : null,
    status: (row.status as InquiryStatus) ?? "received",
    createdAt: String(row.created_at),
    retentionUntil: String(row.retention_until),
    handoffSummary: row.handoff_summary ? String(row.handoff_summary) : null,
    journeyId: row.journey_id ? String(row.journey_id) : null,
  };
}

export async function createInquiry(input: InquiryInput): Promise<Inquiry | null> {
  if (!isLpInquiryDbEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[inquiry-data] Supabase admin client not configured");
    return null;
  }

  if (input.useCase.length > 2000) {
    throw new Error("use_case_too_long");
  }
  if (input.handoffSummary && input.handoffSummary.length > 2000) {
    throw new Error("handoff_summary_too_long");
  }

  const now = new Date().toISOString();
  const retentionUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await admin
    .from("lp_inquiries")
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      source: input.source,
      plan: input.plan,
      billing_preference: input.billingPreference,
      company: input.company,
      contact_name: input.contactName,
      email: input.email,
      phone: input.phone || null,
      headcount: input.headcount || null,
      use_case: input.useCase,
      consent_given: input.consentGiven,
      consent_version: input.consentVersion || null,
      consent_at: input.consentGiven ? now : null,
      status: "received",
      created_at: now,
      retention_until: retentionUntil,
      handoff_summary: input.handoffSummary || null,
      journey_id: input.journeyId || null,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[inquiry-data] Failed to create inquiry:", error);
    throw new Error(error.message || "inquiry_create_failed");
  }

  return mapRow(data as Record<string, unknown>);
}

export async function updateInquiryStatus(
  inquiryId: string,
  status: InquiryStatus
): Promise<boolean> {
  if (!isLpInquiryDbEnabled()) {
    return false;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const { error } = await admin
    .from("lp_inquiries")
    .update({ status })
    .eq("id", inquiryId);

  if (error) {
    console.error("[inquiry-data] Failed to update inquiry status:", error);
    return false;
  }

  return true;
}

export async function getInquiryById(inquiryId: string): Promise<Inquiry | null> {
  if (!isLpInquiryDbEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data, error } = await admin
    .from("lp_inquiries")
    .select("*")
    .eq("id", inquiryId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return mapRow(data as Record<string, unknown>);
}
