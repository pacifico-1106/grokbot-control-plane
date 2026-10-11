import { jsonUtf8 } from "@/lib/http/json-utf8";
import { planRetiredRefusal, priceNotPurchasableRefusal } from "@/lib/billing/purchasable-prices";

export const runtime = "nodejs";

/**
 * Legacy SaaS checkout (starter / business / managed) — CLOSED, no Stripe call
 * and no DB write in any mode.
 *
 * Closed since 10/03 (e6145eb): it used to create a Stripe Customer and a
 * subscription Checkout Session with a free trial, without human approval.
 * Since 10/04 (八坂さん: consolidate on the AI社員パック) the plans it sold are
 * retired, so the answer is explicit:
 * - planKey "business" (AI社員 Lite) / "managed" (AI社員 Standard) → 410 plan_retired
 * - anything else (starter, unknown keys, raw price ids, bad JSON) → 404
 *   price_not_purchasable. This route's purchasable allowlist is EMPTY.
 *
 * The body is read only to choose between those two messages. No Price ID is
 * ever taken from it. The AI社員パック (/api/lp/ai-employee/checkout) is the
 * only purchase path; it checks lib/billing/purchasable-prices.
 */
const RETIRED_PLAN_KEYS = new Set(["business", "managed"]);

export async function POST(req: Request) {
  let planKey: unknown;
  try {
    planKey = ((await req.json()) as { planKey?: unknown } | null)?.planKey;
  } catch {
    planKey = undefined;
  }
  const refusal =
    typeof planKey === "string" && RETIRED_PLAN_KEYS.has(planKey)
      ? planRetiredRefusal()
      : priceNotPurchasableRefusal();
  return jsonUtf8(
    { ok: false, error: refusal.error, message: refusal.message, purchaseUrl: refusal.purchaseUrl },
    { status: refusal.status }
  );
}
