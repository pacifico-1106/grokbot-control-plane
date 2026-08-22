import { NextResponse } from "next/server";
import { sendBillingEmail, sendTrialEndingEmail } from "@/lib/email";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * Stripe webhook handler structure — ready for real keys.
 * Events: subscription lifecycle, invoice paid/failed, trial_will_end.
 */
export async function POST(req: Request) {
  const stripe = getStripe();
  const signature = req.headers.get("stripe-signature");
  const raw = await req.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !secret || secret.startsWith("replace_me")) {
    console.info("[stripe:webhook:stub]", {
      signaturePresent: Boolean(signature),
      bytes: raw.length,
    });
    return NextResponse.json({ received: true, stub: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature || "", secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const notify =
    process.env.BILLING_NOTIFY_EMAIL || "owner@example.com";

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "invoice.paid":
    case "invoice.payment_failed": {
      await sendBillingEmail(
        notify,
        `[AI社員] Stripe: ${event.type}`,
        `<p>イベント <code>${event.type}</code> を受け取りました。</p>
         <p>本番では subscriptions テーブルを同期してください。</p>`
      );
      break;
    }
    case "customer.subscription.trial_will_end": {
      await sendTrialEndingEmail(notify, "ご契約組織", 3);
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true, type: event.type });
}
