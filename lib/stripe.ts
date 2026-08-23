import Stripe from "stripe";
import type { Subscription, SubscriptionStatus } from "./types";

/**
 * Stripe client stub.
 * JP SME billing: card + optional bank transfer via customer_balance
 * (pattern notes from Sealith stripe-billing-strategy; rewritten for this product).
 */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.startsWith("replace_me")) {
    return null;
  }
  return new Stripe(key, {
    typescript: true,
  });
}

export const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || "14");

/** Legacy constant — prefer getCheckoutPaymentMethodTypes(). */
export const JP_PAYMENT_METHOD_TYPES = ["card", "customer_balance"] as const;

/**
 * card always; customer_balance only when STRIPE_ENABLE_CUSTOMER_BALANCE=1
 * (after Dashboard enables bank-transfer / customer balance).
 */
export function getCheckoutPaymentMethodTypes(): Array<
  "card" | "customer_balance"
> {
  const types: Array<"card" | "customer_balance"> = ["card"];
  if (process.env.STRIPE_ENABLE_CUSTOMER_BALANCE === "1") {
    types.push("customer_balance");
  }
  return types;
}

export function describeJpPaymentMethods(): string {
  return [
    "カード決済 (card)",
    "銀行振込 / 顧客残高 (customer_balance) — Dashboard で有効化し STRIPE_ENABLE_CUSTOMER_BALANCE=1 のとき Checkout に追加",
  ].join(" / ");
}

export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function getPriceId(
  planKey: "starter" | "business" | "managed"
): string | null {
  const map = {
    starter: process.env.STRIPE_PRICE_ID_STARTER,
    business: process.env.STRIPE_PRICE_ID_BUSINESS,
    managed: process.env.STRIPE_PRICE_ID_MANAGED,
  } as const;
  const id = map[planKey];
  if (!id || id.startsWith("replace_me")) return null;
  return id;
}

/**
 * One-time business onboarding Price (optional).
 * When set, Checkout for business adds this as an extra line item.
 */
export function getBusinessOnboardingPriceId(): string | null {
  const id = process.env.STRIPE_PRICE_ID_BUSINESS_ONBOARDING;
  if (!id || id.startsWith("replace_me")) return null;
  return id;
}

function envPriceId(name: string): string | null {
  const id = process.env[name];
  if (!id || id.startsWith("replace_me")) return null;
  return id;
}

/**
 * Optional kickoff pack one-time Price (¥398,000 税別・仮決め).
 * Not auto-added to plan Checkout — separate optional purchase when wired.
 * See docs/pricing-sku-catalog.md (transparent 3 lines; no Business M1).
 */
export function getKickoffPackPriceId(): string | null {
  return envPriceId("STRIPE_PRICE_ID_KICKOFF_PACK");
}

/** Subsidy catalog placeholders — null until Dashboard Price IDs are pasted. */
export function getSubsidy2yBusinessPriceId(): string | null {
  return envPriceId("STRIPE_PRICE_ID_SUBSIDY_2Y_BUSINESS");
}

export function getSubsidy2yManagedPriceId(): string | null {
  return envPriceId("STRIPE_PRICE_ID_SUBSIDY_2Y_MANAGED");
}

export function getYear3ExtensionPriceId(): string | null {
  return envPriceId("STRIPE_PRICE_ID_YEAR3_EXTENSION");
}

export type CheckoutPlanKey = "starter" | "business" | "managed";

/** Map Stripe subscription.status → our SubscriptionStatus. */
export function mapStripeSubscriptionStatus(
  status: string | null | undefined
): SubscriptionStatus {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "unpaid":
      return "unpaid";
    case "incomplete":
    case "incomplete_expired":
      return "incomplete";
    case "paused":
      return "past_due";
    default:
      return "incomplete";
  }
}

/** Infer plan from price id env match, else metadata.planKey, else business. */
export function resolvePlanKeyFromStripe(params: {
  priceId?: string | null;
  metadataPlanKey?: string | null;
}): Subscription["planKey"] {
  const starter = process.env.STRIPE_PRICE_ID_STARTER;
  const business = process.env.STRIPE_PRICE_ID_BUSINESS;
  const managed = process.env.STRIPE_PRICE_ID_MANAGED;
  if (
    params.priceId &&
    starter &&
    !starter.startsWith("replace_me") &&
    params.priceId === starter
  ) {
    return "starter";
  }
  if (
    params.priceId &&
    business &&
    !business.startsWith("replace_me") &&
    params.priceId === business
  ) {
    return "business";
  }
  if (
    params.priceId &&
    managed &&
    !managed.startsWith("replace_me") &&
    params.priceId === managed
  ) {
    return "managed";
  }
  const meta = (params.metadataPlanKey || "").toLowerCase();
  if (meta === "starter" || meta === "business" || meta === "managed") {
    return meta;
  }
  // Legacy Stripe metadata / rows may still say enterprise → treat as managed.
  if (meta === "enterprise") {
    return "managed";
  }
  return "business";
}

export function unixToIso(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}
