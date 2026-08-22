import Stripe from "stripe";

/**
 * Stripe client stub.
 * JP SME billing: card + bank transfer via customer_balance
 * (Customer Balance). Documented in README / docs.
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
