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
import { processCardSetupWebhook } from "@/lib/external-contract-card/webhook-handler";
import { processSubscriptionForPlanChange } from "@/lib/billing/stripe-plan-webhook";
import {
  createSupabaseLinkedOrgLookup,
  customerIdOf,
  recordStripeTenantMismatch,
  verifyStripeCustomerOrg,
  type LinkedOrgLookup,
  type TenantCheckRejected,
} from "@/lib/billing/stripe-customer-org-guard";
import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  createSupabaseStripeWebhookEventStore,
  failStripeWebhookEvent,
  rejectStripeWebhookEvent,
  type StripeWebhookEventStore,
} from "@/lib/billing/stripe-webhook-ledger";
import type Stripe from "stripe";

export const runtime = "nodejs";

type Outcome =
  | { kind: "processed"; orgId: string | null; body: Record<string, unknown> }
  | { kind: "rejected"; check: TenantCheckRejected }
  | { kind: "invalid_signature"; error: string };

/** All org ids an object claims (client_reference_id / metadata.orgId / org_id). */
function claimedOrgIds(
  meta: Stripe.Metadata | null | undefined,
  clientReferenceId?: string | null
): string[] {
  const out: string[] = [];
  for (const v of [clientReferenceId, meta?.orgId, meta?.org_id]) {
    const s = v == null ? "" : String(v).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function priceIdFromSubscription(sub: Stripe.Subscription): string | null {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
}

/** Sync a subscription row for an org that already passed the tenant guard. */
async function syncSubscriptionFromStripe(
  sub: Stripe.Subscription,
  orgId: string,
  customerId: string
): Promise<{ orgId: string; synced: boolean }> {
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

  const periodEnd =
    sub.items?.data?.[0]?.current_period_end ??
    (sub as { current_period_end?: number }).current_period_end;

  // Throws on DB error → 5xx → Stripe retries.
  await upsertSubscription({
    orgId,
    planKey,
    status: mapStripeSubscriptionStatus(sub.status),
    stripeSubscriptionId: sub.id,
    stripePriceId: priceId,
    trialEndsAt: unixToIso(sub.trial_end),
    currentPeriodEnd: unixToIso(periodEnd),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    // Already verified equal to orgs.stripe_customer_id (never re-links).
    stripeCustomerId: customerId,
  });

  return { orgId, synced: true };
}

function isStripeNotFound(e: unknown): boolean {
  const err = e as { statusCode?: number; code?: string } | null;
  return Boolean(err && (err.statusCode === 404 || err.code === "resource_missing"));
}

/**
 * Retrieve the subscription. 404 (deleted) → null (permanent, nothing to
 * sync). Any other Stripe error is thrown → 5xx → Stripe retries.
 */
async function retrieveSubscription(
  stripe: Stripe,
  subscriptionRef: string | Stripe.Subscription | null | undefined
): Promise<Stripe.Subscription | null> {
  if (!subscriptionRef) return null;
  if (typeof subscriptionRef !== "string") return subscriptionRef;
  try {
    return await stripe.subscriptions.retrieve(subscriptionRef);
  } catch (e) {
    if (isStripeNotFound(e)) {
      console.warn("[stripe:webhook] subscription not found", { subscriptionRef });
      return null;
    }
    throw e;
  }
}

async function handleEvent(
  stripe: Stripe,
  event: Stripe.Event,
  raw: string,
  signature: string | null,
  lookup: LinkedOrgLookup
): Promise<Outcome> {
  // Card setup events (setup_intent.*, checkout.session.expired mode=setup).
  const cardSetupResult = await processCardSetupWebhook(raw, signature, {
    verifyTenant: (orgId, customerId) =>
      verifyStripeCustomerOrg(
        { claimedOrgIds: [orgId], customerIds: [customerId] },
        lookup
      ),
  });
  if (cardSetupResult.processed) {
    const { eventType, action, orgId } = cardSetupResult;
    if (action !== "ignored") {
      console.info("[stripe:webhook:card-setup]", { eventType, action, orgId });
      return {
        kind: "processed",
        orgId,
        body: { received: true, type: eventType, cardSetup: { action, orgId } },
      };
    }
  } else if (cardSetupResult.reason === "invalid_signature") {
    return {
      kind: "invalid_signature",
      error: cardSetupResult.error || "invalid_signature",
    };
  } else if (cardSetupResult.reason === "tenant_mismatch" && cardSetupResult.tenantCheck) {
    return { kind: "rejected", check: cardSetupResult.tenantCheck };
  } else if (cardSetupResult.reason === "complete_failed") {
    // Payment method could not be persisted (DB) → transient → retry.
    throw new Error("card_setup_complete_failed");
  }
  // Other card-setup reasons (missing metadata, …) are permanent no-ops and
  // fall through to the normal handling, as before.

  const notify = process.env.BILLING_NOTIFY_EMAIL || "owner@example.com";
  let syncedOrgId: string | null = null;

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const claims = claimedOrgIds(sub.metadata);
      let synced = false;
      let planAction: string | undefined;
      if (claims.length === 0) {
        console.warn("[stripe:webhook] missing orgId on subscription", sub.id);
      } else {
        const check = await verifyStripeCustomerOrg(
          { claimedOrgIds: claims, customerIds: [customerIdOf(sub.customer)] },
          lookup
        );
        if (!check.ok) return { kind: "rejected", check };
        const result = await syncSubscriptionFromStripe(sub, check.orgId, check.customerId);
        syncedOrgId = result.orgId;
        synced = result.synced;
        // P1 Plan Rails: throws on failure (not marked processed) → 5xx.
        const planResult = await processSubscriptionForPlanChange(event, check.orgId);
        planAction = planResult.action;
      }

      await sendBillingEmail(
        notify,
        `[AI社員] Stripe: ${event.type}`,
        `<p>イベント <code>${event.type}</code> を受け取りました。</p>
         <p>orgId=<code>${syncedOrgId ?? "unknown"}</code> synced=${synced}</p>
         <p>status=<code>${sub.status}</code> sub=<code>${sub.id}</code></p>
         ${planAction ? `<p>planAction=<code>${planAction}</code></p>` : ""}`
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
        const claims = [
          ...claimedOrgIds(sub.metadata),
          ...claimedOrgIds(
            invoice.metadata ?? invoice.parent?.subscription_details?.metadata ?? null
          ),
        ];
        if (claims.length === 0) {
          console.warn("[stripe:webhook] missing orgId on subscription", sub.id);
        } else {
          const check = await verifyStripeCustomerOrg(
            {
              claimedOrgIds: claims,
              customerIds: [
                customerIdOf(sub.customer),
                customerIdOf(invoice.customer as string | { id?: string } | null),
              ],
            },
            lookup
          );
          if (!check.ok) return { kind: "rejected", check };
          const result = await syncSubscriptionFromStripe(sub, check.orgId, check.customerId);
          syncedOrgId = result.orgId;
        }
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
      const sessionClaims = claimedOrgIds(session.metadata, session.client_reference_id);
      const sessionCustomer = customerIdOf(
        session.customer as string | { id?: string } | null
      );
      const sub = await retrieveSubscription(stripe, session.subscription);
      if (sub) {
        const claims = [...sessionClaims, ...claimedOrgIds(sub.metadata)];
        if (claims.length === 0) {
          console.warn("[stripe:webhook] missing orgId on subscription", sub.id);
          break;
        }
        const check = await verifyStripeCustomerOrg(
          {
            claimedOrgIds: claims,
            customerIds: [sessionCustomer, customerIdOf(sub.customer)],
          },
          lookup
        );
        if (!check.ok) return { kind: "rejected", check };
        const result = await syncSubscriptionFromStripe(sub, check.orgId, check.customerId);
        syncedOrgId = result.orgId;
      } else if (
        session.mode === "subscription" &&
        sessionClaims.length > 0 &&
        sessionCustomer
      ) {
        // Subscription not expandable yet. The customer must already be
        // linked to this org; the webhook never links a customer itself.
        const check = await verifyStripeCustomerOrg(
          { claimedOrgIds: sessionClaims, customerIds: [sessionCustomer] },
          lookup
        );
        if (!check.ok) return { kind: "rejected", check };
        if (!isDemoMode()) {
          await upsertSubscription({
            orgId: check.orgId,
            status: "incomplete",
            stripeCustomerId: check.customerId,
            planKey: resolvePlanKeyFromStripe({
              metadataPlanKey:
                session.metadata?.planKey || session.metadata?.plan_key,
            }),
          });
        }
        syncedOrgId = check.orgId;
      }
      // LP setup-fee sessions (mode=payment, no org) → no-op, as before.
      break;
    }
    case "customer.subscription.trial_will_end": {
      const sub = event.data.object as Stripe.Subscription;
      const claims = claimedOrgIds(sub.metadata);
      if (claims.length === 0) {
        console.warn("[stripe:webhook] missing orgId on subscription", sub.id);
      } else {
        const check = await verifyStripeCustomerOrg(
          { claimedOrgIds: claims, customerIds: [customerIdOf(sub.customer)] },
          lookup
        );
        if (!check.ok) return { kind: "rejected", check };
        const result = await syncSubscriptionFromStripe(sub, check.orgId, check.customerId);
        syncedOrgId = result.orgId;
      }
      await sendTrialEndingEmail(notify, "ご契約組織", 3);
      break;
    }
    default:
      break;
  }

  return {
    kind: "processed",
    orgId: syncedOrgId,
    body: { received: true, type: event.type, orgId: syncedOrgId },
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "unknown_error";
}

/**
 * Stripe webhook — subscription / invoice sync via service role when NOT demo.
 * Also handles card setup events for external contract card registration.
 *
 * Response contract (fail-closed):
 * - invalid signature → 400 (permanent; unchanged)
 * - tenant mismatch (metadata org ≠ org linked to the Customer) → no writes,
 *   audit_events row, 200 { rejected } (permanent; retrying cannot fix it)
 * - transient failure (DB / Stripe API / dedupe store) → 5xx → Stripe retries
 * - duplicate event.id already processed → 200 { duplicate } (no re-run)
 * - same event.id currently being processed → 409 → Stripe retries later
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

  // Dedupe by event.id (claim before processing; done only after success).
  let store: StripeWebhookEventStore | null = null;
  let attempt: number | null = null;
  try {
    store = createSupabaseStripeWebhookEventStore();
    const claim = await claimStripeWebhookEvent(store, event);
    if (claim.kind === "duplicate") {
      return NextResponse.json({ received: true, type: event.type, duplicate: true });
    }
    if (claim.kind === "in_progress") {
      return NextResponse.json(
        { error: "event_in_progress" },
        { status: 409 }
      );
    }
    if (claim.kind === "ledger_unavailable") {
      if (store) {
        console.warn("[stripe:webhook] ledger unavailable, processing without dedupe", {
          eventId: event.id,
          reason: claim.reason,
        });
      }
      store = null;
    } else {
      attempt = claim.attempt;
    }
  } catch (e) {
    console.error("[stripe:webhook] ledger claim failed", {
      eventId: event.id,
      error: errorMessage(e),
    });
    return NextResponse.json({ error: "temporarily_unavailable" }, { status: 503 });
  }

  let outcome: Outcome;
  try {
    outcome = await handleEvent(stripe, event, raw, signature, createSupabaseLinkedOrgLookup());
  } catch (e) {
    console.error("[stripe:webhook] processing failed", {
      eventId: event.id,
      eventType: event.type,
      error: errorMessage(e),
    });
    if (store && attempt != null) {
      try {
        await failStripeWebhookEvent(store, event.id, attempt, e);
      } catch (markErr) {
        // Row stays "processing"; the lease lets the retry re-claim it.
        console.error("[stripe:webhook] ledger fail-mark failed", {
          eventId: event.id,
          error: errorMessage(markErr),
        });
      }
    }
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }

  if (outcome.kind === "invalid_signature") {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }

  if (outcome.kind === "rejected") {
    await recordStripeTenantMismatch(event, outcome.check);
    if (store && attempt != null) {
      try {
        await rejectStripeWebhookEvent(store, event.id, attempt, outcome.check.reason);
      } catch (e) {
        // Nothing was written for this event; let Stripe retry and re-evaluate.
        console.error("[stripe:webhook] ledger reject-mark failed", {
          eventId: event.id,
          error: errorMessage(e),
        });
        return NextResponse.json({ error: "temporarily_unavailable" }, { status: 503 });
      }
    }
    return NextResponse.json({
      received: true,
      type: event.type,
      rejected: outcome.check.reason,
    });
  }

  if (store && attempt != null) {
    try {
      const ok = await completeStripeWebhookEvent(store, event.id, attempt, {
        orgId: outcome.orgId,
      });
      if (!ok) {
        console.warn("[stripe:webhook] ledger complete lost the claim", { eventId: event.id });
      }
    } catch (e) {
      // Processing succeeded; acknowledging avoids re-running side effects.
      console.error("[stripe:webhook] ledger complete failed", {
        eventId: event.id,
        error: errorMessage(e),
      });
    }
  }

  return NextResponse.json(outcome.body);
}
