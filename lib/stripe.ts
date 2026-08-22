import Stripe from "stripe";

/**
 * Stripe client stub.
 * JP SME billing: card + bank transfer via customer_balance
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

export const JP_PAYMENT_METHOD_TYPES = ["card", "customer_balance"] as const;

export function describeJpPaymentMethods(): string {
  return [
    "カード決済 (card)",
    "銀行振込 / 顧客残高 (customer_balance) — 日本の中小企業向け請求フロー向け",
  ].join(" / ");
}

export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function getPriceId(planKey: "starter" | "business"): string | null {
  const map = {
    starter: process.env.STRIPE_PRICE_ID_STARTER,
    business: process.env.STRIPE_PRICE_ID_BUSINESS,
  } as const;
  const id = map[planKey];
  if (!id || id.startsWith("replace_me")) return null;
  return id;
}

export type CheckoutPlanKey = "starter" | "business";
