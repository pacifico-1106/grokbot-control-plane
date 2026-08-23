import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { getOrgStripeCustomerId } from "@/lib/data/subscriptions";
import { isDemoMode } from "@/lib/mode";
import { getAppUrl, getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * Stripe Customer Portal session.
 * Missing keys → stub. Production requires auth org + existing Stripe customer.
 */
export async function POST() {
  const stripe = getStripe();
  const appUrl = getAppUrl();
  const sessionCtx = await getSessionContext();

  if (!stripe) {
    return NextResponse.json({
      ok: true,
      stub: true,
      message:
        "Stripe 未設定のためカスタマーポータルはスタブです。STRIPE_SECRET_KEY を設定し、Dashboard で Portal を有効化してください。",
      preview: {
        return_url: `${appUrl}/app/billing`,
      },
    });
  }

  if (!isDemoMode() && (!sessionCtx.userId || !sessionCtx.orgId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "auth_required",
        message: "ポータルを開くにはログインが必要です。",
      },
      { status: 401 }
    );
  }

  const orgId = sessionCtx.orgId;
  if (!orgId) {
    return NextResponse.json(
      {
        ok: false,
        error: "org_required",
        message: "組織が見つかりません。",
      },
      { status: 400 }
    );
  }

  const customerId = await getOrgStripeCustomerId(orgId);
  if (!customerId) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_stripe_customer",
        message:
          "Stripe 顧客がまだありません。先に Checkout でプランをお申し込みください。",
      },
      { status: 400 }
    );
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/app/billing`,
  });

  return NextResponse.json({ ok: true, url: portal.url });
}
