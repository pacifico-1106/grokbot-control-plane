import { DEMO_SUBSCRIPTION } from "../demo-data";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import type { Subscription, SubscriptionStatus } from "../types";
import { mapSubscriptionRow } from "./mappers";

export type UpsertSubscriptionInput = {
  orgId: string;
  planKey?: Subscription["planKey"];
  status: SubscriptionStatus;
  stripeSubscriptionId?: string | null;
  stripePriceId?: string | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  stripeCustomerId?: string | null;
};

/** Dual-mode: DEMO constant / production subscriptions row. */
export async function getSubscription(
  orgId?: string | null
): Promise<Subscription | null> {
  if (isDemoMode()) {
    return { ...DEMO_SUBSCRIPTION };
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return null;

  const { data, error } = await admin
    .from("subscriptions")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();

  if (error || !data) return null;
  return mapSubscriptionRow(data as Record<string, unknown>);
}

/**
 * Upsert by org_id (unique). Also patches orgs.stripe_customer_id when provided.
 * DEMO: no-op return of merged demo row (keeps build/demo paths green).
 */
export async function upsertSubscription(
  input: UpsertSubscriptionInput
): Promise<Subscription> {
  if (isDemoMode()) {
    return {
      ...DEMO_SUBSCRIPTION,
      orgId: input.orgId || DEMO_SUBSCRIPTION.orgId,
      planKey: input.planKey || DEMO_SUBSCRIPTION.planKey,
      status: input.status,
      stripeSubscriptionId:
        input.stripeSubscriptionId ?? DEMO_SUBSCRIPTION.stripeSubscriptionId,
      trialEndsAt: input.trialEndsAt ?? DEMO_SUBSCRIPTION.trialEndsAt,
      currentPeriodEnd:
        input.currentPeriodEnd ?? DEMO_SUBSCRIPTION.currentPeriodEnd,
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    org_id: input.orgId,
    status: input.status,
    updated_at: now,
  };
  if (input.planKey != null) row.plan_key = input.planKey;
  if (input.stripeSubscriptionId !== undefined) {
    row.stripe_subscription_id = input.stripeSubscriptionId;
  }
  if (input.stripePriceId !== undefined) {
    row.stripe_price_id = input.stripePriceId;
  }
  if (input.trialEndsAt !== undefined) row.trial_ends_at = input.trialEndsAt;
  if (input.currentPeriodEnd !== undefined) {
    row.current_period_end = input.currentPeriodEnd;
  }
  if (input.cancelAtPeriodEnd !== undefined) {
    row.cancel_at_period_end = input.cancelAtPeriodEnd;
  }

  const { data, error } = await admin
    .from("subscriptions")
    .upsert(row, { onConflict: "org_id" })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "subscription_upsert_failed");
  }

  if (input.stripeCustomerId) {
    await admin
      .from("orgs")
      .update({
        stripe_customer_id: input.stripeCustomerId,
        updated_at: now,
      })
      .eq("id", input.orgId);
  }

  return mapSubscriptionRow(data as Record<string, unknown>);
}

export async function getOrgStripeCustomerId(
  orgId: string
): Promise<string | null> {
  if (isDemoMode()) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("orgs")
    .select("stripe_customer_id")
    .eq("id", orgId)
    .maybeSingle();
  const id = (data as { stripe_customer_id?: string | null } | null)
    ?.stripe_customer_id;
  return id ? String(id) : null;
}

export async function setOrgStripeCustomerId(
  orgId: string,
  customerId: string
): Promise<void> {
  if (isDemoMode()) return;
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin
    .from("orgs")
    .update({
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
}
