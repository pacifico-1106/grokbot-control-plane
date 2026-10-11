/**
 * P1 Plan Rails — Stripe webhook plan change detection.
 *
 * Detects plan changes from subscription updates and routes them
 * to appropriate handlers:
 * - Upgrades → create approval ticket (always_human)
 * - Downgrades → schedule for billing period end
 * - Status changes → immediate narrowing for cancel/suspend
 *
 * Uses event.id idempotency via stripe_processed_events table.
 */

import { isPlanRailsEnabled } from "@/lib/feature-flags";
import { isStripeEventProcessed, markStripeEventProcessed } from "./stripe-events";
import { getOrgPlanInfo } from "./org-plan";
import { resolvePlanKeyFromLookupKey, isPlanUpgrade, isPlanDowngrade, type PlanKey } from "./plan-scopes";
import { handlePlanDowngrade, handleBillingStatusChange } from "./plan-change-handler";
import { createUpgradeTicket } from "./plan-upgrade-handler";
import type Stripe from "stripe";

export interface PlanWebhookResult {
  processed: boolean;
  skipped?: "already_processed" | "no_plan_change" | "flag_off" | "demo";
  action?: "upgrade_ticket" | "downgrade_scheduled" | "status_changed" | "no_op";
  error?: string;
  orgId?: string;
  oldPlan?: PlanKey | null;
  newPlan?: PlanKey | null;
}

/**
 * Extract plan key from Stripe subscription.
 * Resolves by lookup_key first, then falls back to metadata.
 */
export function extractPlanKeyFromSubscription(
  sub: Stripe.Subscription
): PlanKey | null {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  
  if (price && typeof price !== "string") {
    const lookupKey = price.lookup_key;
    if (lookupKey) {
      const resolved = resolvePlanKeyFromLookupKey(lookupKey);
      if (resolved) return resolved;
    }
  }

  const metaPlan = sub.metadata?.plan_key ?? sub.metadata?.planKey;
  if (metaPlan) {
    const valid: PlanKey[] = ["intern", "proper", "executive"];
    if (valid.includes(metaPlan as PlanKey)) {
      return metaPlan as PlanKey;
    }
  }

  return null;
}

/**
 * Calculate billing period end for scheduling downgrades.
 */
function getBillingPeriodEnd(sub: Stripe.Subscription): string {
  const periodEnd =
    sub.items?.data?.[0]?.current_period_end ??
    (sub as { current_period_end?: number }).current_period_end;
  
  if (periodEnd) {
    return new Date(periodEnd * 1000).toISOString();
  }
  
  const oneDayLater = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return oneDayLater.toISOString();
}

/**
 * Process a Stripe subscription event for plan changes.
 *
 * Called by the main Stripe webhook handler after signature verification.
 * Uses event.id for idempotency.
 *
 * @param event - The verified Stripe event
 * @param orgId - The org ID from subscription metadata
 */
export async function processSubscriptionForPlanChange(
  event: Stripe.Event,
  orgId: string | null
): Promise<PlanWebhookResult> {
  if (!isPlanRailsEnabled()) {
    return { processed: true, skipped: "flag_off" };
  }

  if (!orgId) {
    return { processed: true, skipped: "no_plan_change", error: "missing_org_id" };
  }

  const alreadyProcessed = await isStripeEventProcessed(event.id);
  if (alreadyProcessed) {
    return { processed: true, skipped: "already_processed", orgId };
  }

  const sub = event.data.object as Stripe.Subscription;
  const newPlanFromStripe = extractPlanKeyFromSubscription(sub);
  const currentInfo = await getOrgPlanInfo(orgId);
  const currentPlan = currentInfo?.planKey ?? null;

  const statusChanged =
    sub.status === "canceled" ||
    sub.status === "paused" ||
    sub.status === "unpaid";
  
  const isStatusNarrowing =
    (sub.status === "canceled" || sub.status === "paused") &&
    currentInfo?.billingStatus !== sub.status;

  let result: PlanWebhookResult = { processed: true, orgId };

  try {
    if (isStatusNarrowing) {
      const statusResult = await handleBillingStatusChange(orgId, sub.status, {
        source: "stripe_webhook",
      });
      result = {
        processed: true,
        action: "status_changed",
        orgId,
        oldPlan: currentPlan,
        newPlan: newPlanFromStripe,
      };
      if (!statusResult.ok) {
        result.error = statusResult.error;
      }
    } else if (newPlanFromStripe && isPlanUpgrade(currentPlan, newPlanFromStripe)) {
      const upgradeResult = await createUpgradeTicket({
        orgId,
        currentPlan,
        newPlan: newPlanFromStripe,
        stripeSubscriptionId: sub.id,
        source: "stripe_checkout",
      });
      result = {
        processed: true,
        action: "upgrade_ticket",
        orgId,
        oldPlan: currentPlan,
        newPlan: newPlanFromStripe,
      };
      if (!upgradeResult.ok) {
        result.error = upgradeResult.error;
      }
    } else if (newPlanFromStripe && isPlanDowngrade(currentPlan, newPlanFromStripe)) {
      const effectiveAt = sub.cancel_at_period_end
        ? getBillingPeriodEnd(sub)
        : getBillingPeriodEnd(sub);
      
      const downgradeResult = await handlePlanDowngrade(
        orgId,
        currentPlan,
        newPlanFromStripe,
        effectiveAt,
        { source: "stripe_webhook" }
      );
      result = {
        processed: true,
        action: "downgrade_scheduled",
        orgId,
        oldPlan: currentPlan,
        newPlan: newPlanFromStripe,
      };
      if (!downgradeResult.ok) {
        result.error = downgradeResult.error;
      }
    } else {
      result = {
        processed: true,
        skipped: "no_plan_change",
        orgId,
        oldPlan: currentPlan,
        newPlan: newPlanFromStripe,
      };
    }

    await markStripeEventProcessed(event.id, event.type, orgId, {
      action: result.action ?? "no_op",
      oldPlan: currentPlan,
      newPlan: newPlanFromStripe,
      subStatus: sub.status,
    });

    return result;
  } catch (e) {
    // Do NOT mark the event processed on failure: the error propagates so the
    // webhook answers 5xx and Stripe retries (fail-closed). Marking it here
    // used to swallow the retry permanently.
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[stripe-plan-webhook] Error processing event", {
      eventId: event.id,
      eventType: event.type,
      orgId,
      error: msg,
    });
    throw e;
  }
}
