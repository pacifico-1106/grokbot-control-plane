import { NextResponse } from "next/server";
import { getStripe, getAppUrl, getCheckoutPaymentMethodTypes } from "@/lib/stripe";

const VALID_PLANS = ["intern", "proper", "executive"] as const;
type AiEmpPlan = (typeof VALID_PLANS)[number];

function getSetupPriceId(plan: AiEmpPlan): string | null {
  if (plan === "intern" || plan === "proper") {
    const id = process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN;
    if (!id || id.startsWith("replace_me")) return null;
    return id;
  }
  if (plan === "executive") {
    const id = process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE;
    if (!id || id.startsWith("replace_me")) return null;
    return id;
  }
  return null;
}

function getSetupYen(plan: AiEmpPlan): number {
  return plan === "executive" ? 300000 : 150000;
}

function getPlanLabel(plan: AiEmpPlan): string {
  switch (plan) {
    case "intern":
      return "インターン";
    case "proper":
      return "プロパー";
    case "executive":
      return "エグゼクティブ";
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const planParam = url.searchParams.get("plan") || "";
  const appUrl = getAppUrl();

  if (!VALID_PLANS.includes(planParam as AiEmpPlan)) {
    return NextResponse.redirect(
      `${appUrl}/lp/ai-employee/checkout?error=invalid_plan`,
      { status: 302 }
    );
  }

  const plan = planParam as AiEmpPlan;
  const stripe = getStripe();
  const priceId = getSetupPriceId(plan);

  if (!stripe || !priceId) {
    return NextResponse.redirect(
      `${appUrl}/lp/ai-employee/checkout?plan=${plan}&fallback=true`,
      { status: 302 }
    );
  }

  const setupYen = getSetupYen(plan);
  const paymentMethodTypes = getCheckoutPaymentMethodTypes();

  const metadata = {
    plan,
    setupYen: String(setupYen),
    source: "lp-ai-employee",
    planLabel: getPlanLabel(plan),
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: paymentMethodTypes,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/lp/ai-employee/thank-you?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `${appUrl}/lp/ai-employee?checkout=canceled`,
      metadata,
      payment_intent_data: {
        metadata,
      },
    });

    if (!session.url) {
      return NextResponse.redirect(
        `${appUrl}/lp/ai-employee/checkout?plan=${plan}&error=session_failed`,
        { status: 302 }
      );
    }

    return NextResponse.redirect(session.url, { status: 302 });
  } catch (error) {
    console.error("[ai-employee-checkout] Stripe session creation failed:", error);
    return NextResponse.redirect(
      `${appUrl}/lp/ai-employee/checkout?plan=${plan}&error=stripe_error`,
      { status: 302 }
    );
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { plan?: string };
  const planParam = body.plan || "";
  const appUrl = getAppUrl();

  if (!VALID_PLANS.includes(planParam as AiEmpPlan)) {
    return NextResponse.json(
      { ok: false, error: "invalid_plan", message: "無効なプランです" },
      { status: 400 }
    );
  }

  const plan = planParam as AiEmpPlan;
  const stripe = getStripe();
  const priceId = getSetupPriceId(plan);

  if (!stripe || !priceId) {
    return NextResponse.json({
      ok: true,
      fallback: true,
      plan,
      setupYen: getSetupYen(plan),
      message: "決済準備中です。相談フォームからお問い合わせください。",
      consultUrl: `${appUrl}/lp/ai-employee/consult?plan=${plan}`,
    });
  }

  const setupYen = getSetupYen(plan);
  const paymentMethodTypes = getCheckoutPaymentMethodTypes();

  const metadata = {
    plan,
    setupYen: String(setupYen),
    source: "lp-ai-employee",
    planLabel: getPlanLabel(plan),
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: paymentMethodTypes,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/lp/ai-employee/thank-you?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `${appUrl}/lp/ai-employee?checkout=canceled`,
      metadata,
      payment_intent_data: {
        metadata,
      },
    });

    return NextResponse.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
      plan,
      setupYen,
    });
  } catch (error) {
    console.error("[ai-employee-checkout] Stripe session creation failed:", error);
    return NextResponse.json(
      { ok: false, error: "stripe_error", message: "決済セッションの作成に失敗しました" },
      { status: 500 }
    );
  }
}
