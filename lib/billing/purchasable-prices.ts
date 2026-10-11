/**
 * Which Stripe Prices may start a NEW purchase (Checkout Session).
 *
 * ALLOWLIST, not a denylist: a Price is purchasable only if it equals the
 * configured value of one of PURCHASABLE_PRICE_ENV_KEYS (the AI社員パック setup
 * fees). Everything else — the retired plans, starter, add-ons, unknown ids —
 * is refused. 八坂さん decided on 2026-10-04 to consolidate on the AI社員パック,
 * so STRIPE_PRICE_ID_BUSINESS (AI社員 Lite), STRIPE_PRICE_ID_MANAGED
 * (AI社員 Standard) and the older STRIPE_PRICE_ID_STARTER are retired: refused
 * with 410 and a clear message (STARTER added per 木村 on #343).
 *
 * This only gates NEW purchases. Existing STARTER / BUSINESS / MANAGED subscribers keep
 * the Billing Portal (cancel, invoices, payment method), plan display and
 * webhook processing — none of those paths call this.
 *
 * Reads process.env directly (no import of @/lib/stripe) so route tests that
 * mock @/lib/stripe still get the real check.
 */

export const PURCHASABLE_PRICE_ENV_KEYS = [
  "STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN",
  "STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER",
  "STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE",
] as const;

/** Retired 2026-10-04. Only used to pick the 410 message; the allowlist is what blocks. */
export const RETIRED_PRICE_ENV_KEYS = [
  "STRIPE_PRICE_ID_BUSINESS",
  "STRIPE_PRICE_ID_MANAGED",
  "STRIPE_PRICE_ID_STARTER",
] as const;

/** Where new customers should go instead (relative, same origin). */
export const AI_EMPLOYEE_PACK_PURCHASE_PATH = "/lp/ai-employee#pricing";

export const PLAN_RETIRED_MESSAGE_JA =
  "このプラン（AI社員 Lite / AI社員 Standard などの旧プラン）の新規のお申し込みは終了しました。新しくご契約いただく場合は AI社員パックをお選びください。すでにご契約中の方は、引き続き「契約内容を管理」から請求書の確認・お支払い方法の変更・解約ができます。";

export const PRICE_NOT_PURCHASABLE_MESSAGE_JA =
  "このプランはオンラインでお申し込みいただけません。AI社員パックをお選びいただくか、お問い合わせください。";

export type PurchasablePriceCheck =
  | { ok: true; priceId: string }
  | {
      ok: false;
      status: 404 | 410;
      error: "plan_retired" | "price_not_purchasable";
      message: string;
      purchaseUrl: string;
    };

function configured(name: string): string | null {
  const v = process.env[name];
  if (!v || v.startsWith("replace_me")) return null;
  return v;
}

function retiredPriceIds(): Set<string> {
  const ids = new Set<string>();
  for (const k of RETIRED_PRICE_ENV_KEYS) {
    const v = configured(k);
    if (v) ids.add(v);
  }
  return ids;
}

/** Configured purchasable Price IDs. A retired price never counts, even if misconfigured onto an allowlisted key. */
export function purchasablePriceIds(): Set<string> {
  const retired = retiredPriceIds();
  const ids = new Set<string>();
  for (const k of PURCHASABLE_PRICE_ENV_KEYS) {
    const v = configured(k);
    if (v && !retired.has(v)) ids.add(v);
  }
  return ids;
}

export function planRetiredRefusal(): Extract<PurchasablePriceCheck, { ok: false }> {
  return {
    ok: false,
    status: 410,
    error: "plan_retired",
    message: PLAN_RETIRED_MESSAGE_JA,
    purchaseUrl: AI_EMPLOYEE_PACK_PURCHASE_PATH,
  };
}

export function priceNotPurchasableRefusal(): Extract<PurchasablePriceCheck, { ok: false }> {
  return {
    ok: false,
    status: 404,
    error: "price_not_purchasable",
    message: PRICE_NOT_PURCHASABLE_MESSAGE_JA,
    purchaseUrl: AI_EMPLOYEE_PACK_PURCHASE_PATH,
  };
}

/** Gate for every Checkout Session / subscription that charges a Price. */
export function checkPurchasablePrice(priceId: string | null | undefined): PurchasablePriceCheck {
  const id = typeof priceId === "string" ? priceId : "";
  if (id && retiredPriceIds().has(id)) return planRetiredRefusal();
  if (id && purchasablePriceIds().has(id)) return { ok: true, priceId: id };
  return priceNotPurchasableRefusal();
}
