import { NextResponse } from "next/server";
import { sendBillingEmail, sendTrialEndingEmail } from "@/lib/email";
import { upsertSubscription } from "@/lib/data/subscriptions";
import { isDemoMode } from "@/lib/mode";
import {
  getStripe,
  mapStripeSubscriptionStatus,
  resolvePlanKeyFromStripe,
  unixToIso,
} from "@/lib/stripe";
import type Stripe from "stripe";

export const runtime = "nodejs";

function orgIdFromMetadata(
  meta: Stripe.Metadata | null | undefined,
  clientReferenceId?: string | null
): string | null {
  if (clientReferenceId && clientReferenceId.trim()) {
    return clientReferenceId.trim();
  }
  if (!meta) return null;
  const v = meta.orgId || meta.org_id;
  return v && String(v).trim() ? String(v).trim() : null;
}

function priceIdFromSubscription(sub: Stripe.Subscription): string | null {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
}

async function syncSubscriptionFromStripe(
  sub: Stripe.Subscription,
  fallbackOrgId?: string | null
): Promise<{ orgId: string | null; synced: boolean }> {
  const orgId =
    orgIdFromMetadata(sub.metadata) ||
    fallbackOrgId ||
    null;

  if (!orgId) {
    console.warn("[stripe:webhook] missing orgId on subscription", sub.id);
    return { orgId: null, synced: false };
  }

  if (isDemoMode()) {
    // Keep webhook green without DB when still on DEMO Supabase keys.
    console.info("[stripe:webhook:demo-skip-upsert]", {
      orgId,
      subId: sub.id,
      status: sub.status,
    });
    return { orgId, synced: false };
  }

  const priceId = priceIdFromSubscription(sub);
  const planKey = resolvePlanKeyFromStripe({
    priceId,
    metadataPlanKey: sub.metadata?.planKey || sub.metadata?.plan_key,
  });
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

  const periodEnd =
    sub.items?.data?.[0]?.current_period_end ??
    (sub as { current_period_end?: number }).current_period_end;

  await upsertSubscription({
    orgId,
    planKey,
    status: mapStripeSubscriptionStatus(sub.status),
    stripeSubscriptionId: sub.id,
    stripePriceId: priceId,
    trialEndsAt: unixToIso(sub.trial_end),
    currentPeriodEnd: unixToIso(periodEnd),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    stripeCustomerId: customerId || null,
  });

  return { orgId, synced: true };
}

async function retrieveSubscription(
  stripe: Stripe,
  subscriptionRef: string | Stripe.Subscription | null | undefined
): Promise<Stripe.Subscription | null> {
  if (!subscriptionRef) return null;
  if (typeof subscriptionRef !== "string") return subscriptionRef;
  try {
    return await stripe.subscriptions.retrieve(subscriptionRef);
  } catch (e) {
    console.warn("[stripe:webhook] subscription retrieve failed", e);
    return null;
  }
}

/**
 * Stripe webhook — subscription / invoice sync via service role when NOT demo.
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

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature || "", secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const notify = process.env.BILLING_NOTIFY_EMAIL || "owner@example.com";
  let syncedOrgId: string | null = null;

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const result = await syncSubscriptionFromStripe(sub);
      syncedOrgId = result.orgId;
      await sendBillingEmail(
        notify,
        `[AI社員] Stripe: ${event.type}`,
        `<p>イベント <code>${event.type}</code> を受け取りました。</p>
         <p>orgId=<code>${result.orgId ?? "unknown"}</code> synced=${result.synced}</p>
         <p>status=<code>${sub.status}</code> sub=<code>${sub.id}</code></p>`
      );
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const parentSub =
        invoice.parent?.subscription_details?.subscription ??
        (invoice as { subscription?: string | Stripe.Subscription | null })
          .subscription ??
        null;
      const sub = await retrieveSubscription(stripe, parentSub);
      if (sub) {
        const orgFromInvoice = orgIdFromMetadata(
          invoice.metadata ??
            invoice.parent?.subscription_details?.metadata ??
            null
        );
        const result = await syncSubscriptionFromStripe(sub, orgFromInvoice);
        syncedOrgId = result.orgId;
      }
      await sendBillingEmail(
        notify,
        `[AI社員] Stripe: ${event.type}`,
        `<p>イベント <code>${event.type}</code> を受け取りました。</p>
         <p>invoice=<code>${invoice.id}</code> orgId=<code>${syncedOrgId ?? "unknown"}</code></p>`
      );
      break;
    }
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgId = orgIdFromMetadata(
        session.metadata,
        session.client_reference_id
      );
      const sub = await retrieveSubscription(stripe, session.subscription);
      if (sub) {
        // Prefer checkout client_reference_id / metadata.orgId
        if (orgId && !sub.metadata?.orgId && !sub.metadata?.org_id) {
          sub.metadata = { ...(sub.metadata || {}), orgId, org_id: orgId };
        }
        const result = await syncSubscriptionFromStripe(sub, orgId);
        syncedOrgId = result.orgId;
      } else if (orgId && session.customer) {
        // Customer created but subscription not yet expandable — store customer id
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : session.customer.id;
        if (!isDemoMode() && customerId) {
          await upsertSubscription({
            orgId,
            status: "incomplete",
            stripeCustomerId: customerId,
            planKey: resolvePlanKeyFromStripe({
              metadataPlanKey:
                session.metadata?.planKey || session.metadata?.plan_key,
            }),
          });
        }
        syncedOrgId = orgId;
      }
      break;
    }
    case "customer.subscription.trial_will_end": {
      const sub = event.data.object as Stripe.Subscription;
      const result = await syncSubscriptionFromStripe(sub);
      syncedOrgId = result.orgId;
      await sendTrialEndingEmail(notify, "ご契約組織", 3);
      break;
    }
    default:
      break;
  }

  return NextResponse.json({
    received: true,
    type: event.type,
    orgId: syncedOrgId,
  });
}
