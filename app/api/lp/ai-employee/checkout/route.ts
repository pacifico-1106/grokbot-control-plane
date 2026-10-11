import { getStripe, getAppUrl, getCheckoutPaymentMethodTypes } from "@/lib/stripe";
import { getCatalogItem, getSetupPriceId, getPlanLabel, isValidCheckoutPlan, type CheckoutPlan } from "@/lib/lp/catalog";
import { isLpOrderLedgerEnabled } from "@/lib/feature-flags";
import { createOrder, createCheckoutAttempt, updateCheckoutAttemptStatus } from "@/lib/lp/order-ledger";
import { LP_PAGE_PARAM, lpPageHomePath, normalizeLpPage, resolveLpRef, withLpPageParam } from "@/lib/lp/lp-page";
import { jsonUtf8 } from "@/lib/http/json-utf8";

const ALLOWED_ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL,
  "https://staffpass.sealith.com",
].filter(Boolean);

function verifyOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  
  const appUrl = getAppUrl();
  const allowed = [appUrl, ...ALLOWED_ORIGINS];
  
  return allowed.some((allowedOrigin) => {
    if (!allowedOrigin) return false;
    try {
      const allowedUrl = new URL(allowedOrigin);
      const originUrl = new URL(origin);
      return allowedUrl.origin === originUrl.origin;
    } catch {
      return origin === allowedOrigin;
    }
  });
}

/**
 * GET: Return checkout confirmation data (no Stripe session creation).
 * This is a safe operation that can be prefetched.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const planParam = url.searchParams.get("plan") || "";
  const lpPage = normalizeLpPage(url.searchParams.get(LP_PAGE_PARAM));
  const appUrl = getAppUrl();

  if (!isValidCheckoutPlan(planParam)) {
    return jsonUtf8(
      { 
        ok: false, 
        error: "invalid_plan", 
        message: "無効なプランです",
        validPlans: ["intern", "proper", "executive"],
      },
      { status: 400 }
    );
  }

  const plan = planParam as CheckoutPlan;
  const catalogItem = await getCatalogItem(plan);

  if (!catalogItem) {
    return jsonUtf8(
      { ok: false, error: "plan_not_found", message: "プランが見つかりません" },
      { status: 404 }
    );
  }

  const priceId = getSetupPriceId(catalogItem);
  const stripe = getStripe();
  const checkoutAvailable = Boolean(stripe && priceId);

  return jsonUtf8({
    ok: true,
    plan,
    planLabel: getPlanLabel(plan),
    setupAmountExTax: catalogItem.setupAmountExTax,
    monthlyAmountExTax: catalogItem.monthlyAmountExTax,
    catalogVersion: catalogItem.catalogVersionKey,
    checkoutAvailable,
    consultUrl: `${appUrl}${withLpPageParam(`/lp/ai-employee/consult?plan=${plan}`, lpPage)}`,
    message: checkoutAvailable 
      ? "決済準備完了" 
      : "決済準備中です。相談フォームからお問い合わせください。",
  });
}

/**
 * POST: Create Stripe Checkout session.
 * Requires user-initiated action. Origin checked. Creates order if ledger enabled.
 */
export async function POST(req: Request) {
  if (!verifyOrigin(req)) {
    return jsonUtf8(
      { ok: false, error: "origin_denied", message: "不正なリクエストです" },
      { status: 403 }
    );
  }

  let body: { plan?: string; email?: string; requestId?: string; lpPage?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonUtf8(
      { ok: false, error: "invalid_json", message: "リクエストが不正です" },
      { status: 400 }
    );
  }

  const { plan: planParam, email, requestId } = body;
  // Lead page: allowlist only (unknown → original page). Ref: only for B, only from the
  // validated HttpOnly cookie set by middleware; body fields named ref / lpRef are ignored.
  const lpPage = normalizeLpPage(body.lpPage);
  const lpRef = resolveLpRef(lpPage, req.headers.get("cookie"));
  const appUrl = getAppUrl();

  if (!planParam || !isValidCheckoutPlan(planParam)) {
    return jsonUtf8(
      { ok: false, error: "invalid_plan", message: "無効なプランです" },
      { status: 400 }
    );
  }

  const plan = planParam as CheckoutPlan;
  const catalogItem = await getCatalogItem(plan);

  if (!catalogItem) {
    return jsonUtf8(
      { ok: false, error: "plan_not_found", message: "プランが見つかりません" },
      { status: 404 }
    );
  }

  const stripe = getStripe();
  const priceId = getSetupPriceId(catalogItem);

  if (!stripe || !priceId) {
    return jsonUtf8({
      ok: true,
      fallback: true,
      plan,
      planLabel: getPlanLabel(plan),
      setupAmountExTax: catalogItem.setupAmountExTax,
      message: "決済準備中です。相談フォームからお問い合わせください。",
      consultUrl: `${appUrl}${withLpPageParam(`/lp/ai-employee/consult?plan=${plan}`, lpPage)}`,
    });
  }

  const setupAmountExTax = catalogItem.setupAmountExTax ?? 0;
  const paymentMethodTypes = getCheckoutPaymentMethodTypes();

  const metadata: Record<string, string> = {
    plan,
    setupYen: String(setupAmountExTax),
    source: "lp-ai-employee",
    planLabel: getPlanLabel(plan),
    catalogVersion: catalogItem.catalogVersionKey,
    lpPage,
    ...(lpRef ? { lpRef } : {}),
  };

  let orderId: string | undefined;
  let attemptId: string | undefined;

  if (isLpOrderLedgerEnabled() && email) {
    try {
      const order = await createOrder({
        email,
        sku: plan,
        catalogVersionKey: catalogItem.catalogVersionKey,
        snapshot: {
          plan,
          setupAmountExTax,
          monthlyAmountExTax: catalogItem.monthlyAmountExTax,
          catalogVersion: catalogItem.catalogVersionKey,
        },
        termsVersion: "lp-v1",
      });

      if (order) {
        orderId = order.id;
        metadata.orderId = orderId;

        const attempt = await createCheckoutAttempt({
          orderId,
          revision: order.currentRevision,
          stripeMode: "payment",
        });

        if (attempt) {
          attemptId = attempt.id;
        }
      }
    } catch (error) {
      console.error("[checkout] Order creation failed:", error);
    }
  }

  try {
    // Fixed paths + allowlisted page only; nothing from the request body (no open redirect).
    const successUrl = `${appUrl}${withLpPageParam(`/lp/ai-employee/thank-you?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`, lpPage)}`;
    const cancelUrl = `${appUrl}${lpPageHomePath(lpPage)}?checkout=canceled`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: paymentMethodTypes,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      payment_intent_data: {
        metadata,
      },
    });

    if (attemptId && session.id) {
      await updateCheckoutAttemptStatus(attemptId, "pending", session.id);
    }

    return jsonUtf8({
      ok: true,
      url: session.url,
      sessionId: session.id,
      plan,
      planLabel: getPlanLabel(plan),
      setupAmountExTax,
      orderId,
    });
  } catch (error) {
    console.error("[checkout] Stripe session creation failed:", error);
    
    if (attemptId) {
      await updateCheckoutAttemptStatus(attemptId, "failed");
    }

    return jsonUtf8(
      { ok: false, error: "stripe_error", message: "決済セッションの作成に失敗しました" },
      { status: 500 }
    );
  }
}
