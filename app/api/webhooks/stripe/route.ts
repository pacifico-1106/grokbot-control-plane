import { NextResponse } from "next/server";
import { sendBillingEmail } from "@/lib/email";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * Stripe webhook stub.
 * Handles subscription lifecycle; sends billing mail via Resend.
 */
export async function POST(req: Request) {
  const stripe = getStripe();
  const signature = req.headers.get("stripe-signature");
  const raw = await req.text();

  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET.startsWith("replace_me")) {
    console.info("[stripe:webhook:stub]", { signaturePresent: Boolean(signature), bytes: raw.length });
    return NextResponse.json({ received: true, stub: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      raw,
      signature || "",
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "invoice.paid":
    case "invoice.payment_failed": {
      const email =
        ("customer_email" in event.data.object &&
          (event.data.object as { customer_email?: string }).customer_email) ||
        process.env.BILLING_NOTIFY_EMAIL ||
        "owner@example.com";
      await sendBillingEmail(
        email,
        `[AI社員] Stripe: ${event.type}`,
        `<p>イベント <code>${event.type}</code> を受け取りました。</p>`
      );
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
