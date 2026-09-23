/**
 * P1 External Contract Card Setup Webhook Handler
 *
 * Handles Stripe webhook events for setup_intent lifecycle:
 * - setup_intent.succeeded → persist payment method token + audit
 * - setup_intent.canceled → audit failure
 * - checkout.session.expired → audit expiry
 *
 * CRITICAL SECURITY CONSTRAINTS:
 * - Verify Stripe webhook signature (fail-closed on invalid)
 * - NEVER log full webhook payloads with card details
 * - Only log safe metadata: setupIntentId, customerId, orgId, outcome
 * - Idempotent: check if already processed before persisting
 * - Only store stripe_payment_method_id (pm_xxx) — never raw card data
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { isExternalContractCardSetupEnabled } from "./feature-flag";
import {
  completePaymentMethodSetup,
  failPaymentMethodSetup,
  recordCardAuditEvent,
  getPaymentMethodBySetupIntent,
  isSetupIntentProcessed,
} from "./data";
import type { CardSetupSessionMetadata } from "./checkout-setup";

export type WebhookProcessResult =
  | {
      processed: true;
      eventType: string;
      action: "setup_completed" | "setup_failed" | "setup_expired" | "ignored";
      orgId: string | null;
    }
  | {
      processed: false;
      reason: string;
      error?: string;
    };

/**
 * Process a setup_intent.succeeded event.
 * Persists the payment method token and records audit event.
 *
 * CRITICAL: Only logs safe metadata — never card details.
 */
async function handleSetupIntentSucceeded(
  event: Stripe.Event
): Promise<WebhookProcessResult> {
  const setupIntent = event.data.object as Stripe.SetupIntent;
  const setupIntentId = setupIntent.id;
  const paymentMethodId =
    typeof setupIntent.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id;
  const customerId =
    typeof setupIntent.customer === "string"
      ? setupIntent.customer
      : setupIntent.customer?.id;

  const metadata = setupIntent.metadata as CardSetupSessionMetadata | null;
  const orgId = metadata?.orgId || null;
  const approvalId = metadata?.approvalId || null;

  if (metadata?.purpose !== "payment_method_setup") {
    return {
      processed: true,
      eventType: event.type,
      action: "ignored",
      orgId,
    };
  }

  if (!orgId || !approvalId || !paymentMethodId) {
    console.warn("[card-setup:webhook] missing required metadata", {
      setupIntentId,
      hasOrgId: Boolean(orgId),
      hasApprovalId: Boolean(approvalId),
      hasPaymentMethodId: Boolean(paymentMethodId),
    });
    return {
      processed: false,
      reason: "missing_metadata",
    };
  }

  const alreadyProcessed = await isSetupIntentProcessed(setupIntentId);
  if (alreadyProcessed) {
    return {
      processed: true,
      eventType: event.type,
      action: "setup_completed",
      orgId,
    };
  }

  try {
    await completePaymentMethodSetup({
      orgId,
      stripePaymentMethodId: paymentMethodId,
      stripeSetupIntentId: setupIntentId,
      setupApprovalId: approvalId,
    });

    await recordCardAuditEvent({
      orgId,
      action: "setup_completed",
      approvalId,
      stripeSessionId: setupIntentId,
      outcome: "success",
      metadata: {
        customerId,
      },
    });

    console.info("[card-setup:webhook] setup completed", {
      orgId,
      setupIntentId,
    });

    return {
      processed: true,
      eventType: event.type,
      action: "setup_completed",
      orgId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.error("[card-setup:webhook] complete failed", {
      orgId,
      setupIntentId,
      error: message,
    });
    return {
      processed: false,
      reason: "complete_failed",
      error: message,
    };
  }
}

/**
 * Process a setup_intent.canceled event.
 * Records audit event for failure.
 */
async function handleSetupIntentCanceled(
  event: Stripe.Event
): Promise<WebhookProcessResult> {
  const setupIntent = event.data.object as Stripe.SetupIntent;
  const setupIntentId = setupIntent.id;
  const metadata = setupIntent.metadata as CardSetupSessionMetadata | null;
  const orgId = metadata?.orgId || null;
  const approvalId = metadata?.approvalId || null;

  if (metadata?.purpose !== "payment_method_setup") {
    return {
      processed: true,
      eventType: event.type,
      action: "ignored",
      orgId,
    };
  }

  if (!orgId) {
    return {
      processed: false,
      reason: "missing_org_id",
    };
  }

  const alreadyProcessed = await isSetupIntentProcessed(setupIntentId);
  if (alreadyProcessed) {
    return {
      processed: true,
      eventType: event.type,
      action: "setup_failed",
      orgId,
    };
  }

  await failPaymentMethodSetup(orgId, setupIntentId);

  await recordCardAuditEvent({
    orgId,
    action: "setup_failed",
    approvalId,
    stripeSessionId: setupIntentId,
    outcome: "failure",
    metadata: {
      reason: "canceled",
    },
  });

  console.info("[card-setup:webhook] setup canceled", {
    orgId,
    setupIntentId,
  });

  return {
    processed: true,
    eventType: event.type,
    action: "setup_failed",
    orgId,
  };
}

/**
 * Process a checkout.session.expired event.
 * Records audit event for expiry if it's a card setup session.
 */
async function handleCheckoutSessionExpired(
  event: Stripe.Event
): Promise<WebhookProcessResult> {
  const session = event.data.object as Stripe.Checkout.Session;
  const metadata = session.metadata as CardSetupSessionMetadata | null;
  const orgId = metadata?.orgId || null;
  const approvalId = metadata?.approvalId || null;

  if (session.mode !== "setup" || metadata?.purpose !== "payment_method_setup") {
    return {
      processed: true,
      eventType: event.type,
      action: "ignored",
      orgId,
    };
  }

  if (!orgId) {
    return {
      processed: false,
      reason: "missing_org_id",
    };
  }

  const setupIntentId = session.setup_intent as string | null;

  if (setupIntentId) {
    await failPaymentMethodSetup(orgId, setupIntentId);
  }

  await recordCardAuditEvent({
    orgId,
    action: "setup_expired",
    approvalId,
    stripeSessionId: session.id,
    outcome: "expired",
  });

  console.info("[card-setup:webhook] session expired", {
    orgId,
    sessionId: session.id,
  });

  return {
    processed: true,
    eventType: event.type,
    action: "setup_expired",
    orgId,
  };
}

/**
 * Process incoming Stripe webhook event for card setup.
 *
 * @param rawBody - Raw request body (string)
 * @param signature - Stripe-Signature header
 * @returns Processing result
 */
export async function processCardSetupWebhook(
  rawBody: string,
  signature: string | null
): Promise<WebhookProcessResult> {
  if (!isExternalContractCardSetupEnabled()) {
    return {
      processed: true,
      eventType: "unknown",
      action: "ignored",
      orgId: null,
    };
  }

  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !secret || secret.startsWith("replace_me")) {
    console.info("[card-setup:webhook] stripe not configured, ignoring");
    return {
      processed: true,
      eventType: "unknown",
      action: "ignored",
      orgId: null,
    };
  }

  if (!signature) {
    return {
      processed: false,
      reason: "missing_signature",
    };
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_signature";
    console.warn("[card-setup:webhook] signature verification failed", {
      error: message,
    });
    return {
      processed: false,
      reason: "invalid_signature",
      error: message,
    };
  }

  switch (event.type) {
    case "setup_intent.succeeded":
      return handleSetupIntentSucceeded(event);

    case "setup_intent.canceled":
      return handleSetupIntentCanceled(event);

    case "checkout.session.expired":
      return handleCheckoutSessionExpired(event);

    default:
      return {
        processed: true,
        eventType: event.type,
        action: "ignored",
        orgId: null,
      };
  }
}
