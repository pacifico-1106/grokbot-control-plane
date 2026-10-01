/**
 * P1 Plan Rails — Org plan_key and billing_status data layer.
 *
 * Provides functions to read and update org plan information.
 * Plan filtering logic is in plan-scopes.ts; this module handles persistence.
 *
 * FEATURE FLAG: P1_PLAN_RAILS_ENABLED must be ON for plan filtering to apply.
 * These functions work regardless of flag state (data layer only).
 */

import { DEMO_ORG } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { PlanKey } from "./plan-scopes";

export interface OrgPlanInfo {
  orgId: string;
  planKey: PlanKey | null;
  billingStatus: string | null;
  scheduledPlanKey: PlanKey | null;
  scheduledPlanEffectiveAt: string | null;
}

/**
 * Get plan info for an org.
 *
 * DEMO mode: returns DEMO_ORG with null plan (legacy behavior).
 */
export async function getOrgPlanInfo(
  orgId: string
): Promise<OrgPlanInfo | null> {
  if (isDemoMode()) {
    return {
      orgId: DEMO_ORG.id,
      planKey: null,
      billingStatus: null,
      scheduledPlanKey: null,
      scheduledPlanEffectiveAt: null,
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data, error } = await admin
    .from("orgs")
    .select("id, plan_key, billing_status, scheduled_plan_key, scheduled_plan_effective_at")
    .eq("id", orgId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    orgId: data.id,
    planKey: data.plan_key as PlanKey | null,
    billingStatus: data.billing_status,
    scheduledPlanKey: data.scheduled_plan_key as PlanKey | null,
    scheduledPlanEffectiveAt: data.scheduled_plan_effective_at,
  };
}

/**
 * Update org plan_key and optionally billing_status.
 * Used by Stripe webhook handlers and plan change approval.
 *
 * DEMO mode: no-op.
 */
export async function updateOrgPlanKey(
  orgId: string,
  planKey: PlanKey | null,
  billingStatus?: string | null
): Promise<void> {
  if (isDemoMode()) {
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const update: Record<string, unknown> = {
    plan_key: planKey,
    updated_at: new Date().toISOString(),
  };

  if (billingStatus !== undefined) {
    update.billing_status = billingStatus;
  }

  const { error } = await admin.from("orgs").update(update).eq("id", orgId);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Update org billing_status only (without changing plan_key).
 * Used for status sync from Stripe webhooks.
 *
 * DEMO mode: no-op.
 */
export async function updateOrgBillingStatus(
  orgId: string,
  billingStatus: string | null
): Promise<void> {
  if (isDemoMode()) {
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const { error } = await admin
    .from("orgs")
    .update({
      billing_status: billingStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Schedule a plan downgrade to take effect at billing period end.
 * Stores scheduled_plan_key and scheduled_plan_effective_at.
 *
 * DEMO mode: no-op.
 */
export async function scheduleOrgPlanDowngrade(
  orgId: string,
  newPlanKey: PlanKey | null,
  effectiveAt: string
): Promise<void> {
  if (isDemoMode()) {
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const { error } = await admin
    .from("orgs")
    .update({
      scheduled_plan_key: newPlanKey,
      scheduled_plan_effective_at: effectiveAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Apply a scheduled plan downgrade (clear scheduled fields and update plan_key).
 * Called when billing period ends or subscription is updated.
 *
 * DEMO mode: no-op.
 */
export async function applyScheduledPlanChange(orgId: string): Promise<{
  applied: boolean;
  oldPlanKey: PlanKey | null;
  newPlanKey: PlanKey | null;
}> {
  if (isDemoMode()) {
    return { applied: false, oldPlanKey: null, newPlanKey: null };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const { data: current, error: fetchError } = await admin
    .from("orgs")
    .select("plan_key, scheduled_plan_key, scheduled_plan_effective_at")
    .eq("id", orgId)
    .maybeSingle();

  if (fetchError || !current) {
    return { applied: false, oldPlanKey: null, newPlanKey: null };
  }

  const scheduledKey = current.scheduled_plan_key as PlanKey | null;
  if (!scheduledKey && scheduledKey !== null) {
    return { applied: false, oldPlanKey: current.plan_key, newPlanKey: null };
  }

  const oldPlanKey = current.plan_key as PlanKey | null;

  const { error: updateError } = await admin
    .from("orgs")
    .update({
      plan_key: scheduledKey,
      scheduled_plan_key: null,
      scheduled_plan_effective_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return { applied: true, oldPlanKey, newPlanKey: scheduledKey };
}

/**
 * Clear scheduled plan change (e.g., when downgrade is cancelled).
 *
 * DEMO mode: no-op.
 */
export async function clearScheduledPlanChange(orgId: string): Promise<void> {
  if (isDemoMode()) {
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const { error } = await admin
    .from("orgs")
    .update({
      scheduled_plan_key: null,
      scheduled_plan_effective_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);

  if (error) {
    throw new Error(error.message);
  }
}
