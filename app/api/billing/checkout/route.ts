import { NextResponse } from "next/server";
import { DEMO_ORG } from "@/lib/demo-data";
import {
  getAppUrl,
  getPriceId,
  getStripe,
  TRIAL_DAYS,
  type CheckoutPlanKey,
} from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * Stripe Checkout Session stub.
 * Ready for real keys: creates subscription with trial + JP payment method notes.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    planKey?: CheckoutPlanKey;
  };
  const planKey: CheckoutPlanKey = body.planKey === "starter" ? "starter" : "business";
  const stripe = getStripe();
  const priceId = getPriceId(planKey);
  const appUrl = getAppUrl();

  if (!stripe || !priceId) {
    return NextResponse.json({
      ok: true,
      stub: true,
      planKey,
      message:
        "Stripe 未設定のため Checkout はスタブです。STRIPE_SECRET_KEY と STRIPE_PRICE_ID_* を設定してください。",
      preview: {
        mode: "subscription",
        trial_period_days: TRIAL_DAYS,
        payment_method_types: ["card", "customer_balance"],
        success_url: `${appUrl}/app/billing?checkout=success&plan=${planKey}`,
        cancel_url: `${appUrl}/app/billing?checkout=canceled`,
        metadata: { orgId: DEMO_ORG.id, planKey },
      },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    success_url: `${appUrl}/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}&plan=${planKey}`,
    cancel_url: `${appUrl}/app/billing?checkout=canceled`,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { orgId: DEMO_ORG.id, planKey },
    },
    metadata: { orgId: DEMO_ORG.id, planKey },
    // card always; customer_balance for JP bank-transfer style invoicing when enabled in Dashboard
    payment_method_types: ["card"],
    allow_promotion_codes: false,
  });

  return NextResponse.json({ ok: true, url: session.url, sessionId: session.id });
}
