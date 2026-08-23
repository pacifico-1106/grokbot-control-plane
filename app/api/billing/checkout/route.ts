import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { setOrgReferralCodeIfEmpty } from "@/lib/data/org-context";
import {
  getOrgStripeCustomerId,
  setOrgStripeCustomerId,
} from "@/lib/data/subscriptions";
import { DEMO_ORG } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import {
  getAppUrl,
  getBusinessOnboardingPriceId,
  getCheckoutPaymentMethodTypes,
  getPriceId,
  getStripe,
  TRIAL_DAYS,
  type CheckoutPlanKey,
} from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * Stripe Checkout Session.
 * DEMO / missing keys → stub JSON. Production → require auth org + Customer.
 * Business may include one-time onboarding line item when
 * STRIPE_PRICE_ID_BUSINESS_ONBOARDING is set.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    planKey?: CheckoutPlanKey;
    referral_code?: string;
    referralCode?: string;
  };
  const planKey: CheckoutPlanKey =
    body.planKey === "starter"
      ? "starter"
      : body.planKey === "managed"
        ? "managed"
        : "business";
  const referralRaw = body.referral_code || body.referralCode || "";
  const stripe = getStripe();
  const priceId = getPriceId(planKey);
  const onboardingPriceId =
    planKey === "business" ? getBusinessOnboardingPriceId() : null;
  const appUrl = getAppUrl();
  const paymentMethodTypes = getCheckoutPaymentMethodTypes();
  const sessionCtx = await getSessionContext();

  const lineItemsPreview: Array<{ price: string; quantity: number }> = [
    { price: priceId || `replace_me_price_${planKey}`, quantity: 1 },
  ];
  // Only when env Price ID is set (never invent fake live ids).
  if (onboardingPriceId) {
    lineItemsPreview.push({ price: onboardingPriceId, quantity: 1 });
  }

  if (!stripe || !priceId) {
    const orgId = sessionCtx.orgId || DEMO_ORG.id;
    const referralCode = await setOrgReferralCodeIfEmpty(orgId, referralRaw);
    const metaStub: Record<string, string> = {
      orgId,
      org_id: orgId,
      planKey,
    };
    if (referralCode) metaStub.referral_code = referralCode;
    return NextResponse.json({
      ok: true,
      stub: true,
      planKey,
      referralCode: referralCode || undefined,
      message:
        "Stripe 未設定のため Checkout はスタブです。STRIPE_SECRET_KEY と STRIPE_PRICE_ID_* を設定してください。",
      preview: {
        mode: "subscription",
        trial_period_days: TRIAL_DAYS,
        payment_method_types: paymentMethodTypes,
        success_url: `${appUrl}/app/billing?checkout=success&plan=${planKey}`,
        cancel_url: `${appUrl}/app/billing?checkout=canceled`,
        client_reference_id: orgId,
        metadata: metaStub,
        line_items: lineItemsPreview,
        include_business_onboarding:
          planKey === "business" && Boolean(onboardingPriceId),
        subscription_data: {
          trial_period_days: TRIAL_DAYS,
          metadata: metaStub,
        },
      },
    });
  }

  // Production path: require authenticated org
  if (!isDemoMode()) {
    if (!sessionCtx.userId || !sessionCtx.orgId) {
      return NextResponse.json(
        {
          ok: false,
          error: "auth_required",
          message:
            "Checkout にはログインと組織が必要です。ログイン後に再度お試しください。",
        },
        { status: 401 }
      );
    }
  }

  const orgId = sessionCtx.orgId || DEMO_ORG.id;
  const email = sessionCtx.email || undefined;
  const referralCode = await setOrgReferralCodeIfEmpty(orgId, referralRaw);

  let customerId = await getOrgStripeCustomerId(orgId);
  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      metadata: { orgId, org_id: orgId },
      name: undefined,
    });
    customerId = customer.id;
    await setOrgStripeCustomerId(orgId, customerId);
  }

  const meta: Record<string, string> = { orgId, org_id: orgId, planKey };
  if (referralCode) meta.referral_code = referralCode;

  const line_items: Array<{ price: string; quantity: number }> = [
    { price: priceId, quantity: 1 },
  ];
  // One-time onboarding for business when Price ID is configured.
  if (onboardingPriceId) {
    line_items.push({ price: onboardingPriceId, quantity: 1 });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: orgId,
    success_url: `${appUrl}/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}&plan=${planKey}`,
    cancel_url: `${appUrl}/app/billing?checkout=canceled`,
    line_items,
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: meta,
    },
    metadata: meta,
    payment_method_types: paymentMethodTypes,
    allow_promotion_codes: false,
  });

  return NextResponse.json({
    ok: true,
    url: session.url,
    sessionId: session.id,
  });
}
