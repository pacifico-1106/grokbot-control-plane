/**
 * P1 External Contract Card Checkout Setup Session
 *
 * Creates Stripe Checkout session with mode=setup for payment method registration.
 * This is SEPARATE from AI employee pack Checkout (mode=payment/subscription).
 *
 * CRITICAL SECURITY CONSTRAINTS:
 * - Stripe-hosted only (no in-chat card forms)
 * - Short-lived deep links with expiry
 * - always_human approval gate before link mint
 * - Session metadata.purpose=payment_method_setup to distinguish from pack Checkout
 * - NEVER log card data (PAN/CVV/expiry/fingerprint)
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

import { getStripe, getAppUrl } from "@/lib/stripe";
import {
  getOrgStripeCustomerId,
  setOrgStripeCustomerId,
} from "@/lib/data/subscriptions";
import { isDemoMode } from "@/lib/mode";
import { checkExternalContractCardSetupFlag } from "./feature-flag";
import {
  createPendingPaymentMethod,
  recordCardAuditEvent,
} from "./data";
import type { ExternalContractPaymentMethod } from "./types";

/**
 * Session metadata for external contract card setup.
 * purpose=payment_method_setup distinguishes from AI employee pack Checkout.
 * Extends Record<string, string> for Stripe API compatibility.
 */
export interface CardSetupSessionMetadata extends Record<string, string> {
  purpose: "payment_method_setup";
  orgId: string;
  approvalId: string;
}

export type CreateCardSetupSessionResult =
  | {
      ok: true;
      sessionId: string;
      sessionUrl: string;
      setupIntentId: string;
      expiresAt: string;
      paymentMethod: ExternalContractPaymentMethod;
    }
  | {
      ok: false;
      code: string;
      error: string;
      messageJa: string;
      nextStepJa: string;
    };

/**
 * Create a Stripe Checkout session for payment method setup (mode=setup).
 *
 * IMPORTANT: This is called AFTER always_human approval is granted.
 * The approval flow is handled separately by the admin MCP queue.
 *
 * @param orgId - Organization ID
 * @param approvalId - always_human approval ID (required)
 * @param actorUserId - User who initiated the setup
 * @param actorEmail - Email of the user
 */
export async function createCardSetupSession(input: {
  orgId: string;
  approvalId: string;
  actorUserId?: string;
  actorEmail?: string;
}): Promise<CreateCardSetupSessionResult> {
  const flagCheck = checkExternalContractCardSetupFlag();
  if (!flagCheck.enabled && flagCheck.error) {
    return {
      ok: false,
      code: flagCheck.error.code,
      error: flagCheck.error.error,
      messageJa: flagCheck.error.messageJa,
      nextStepJa: flagCheck.error.nextStepJa,
    };
  }

  const stripe = getStripe();
  const appUrl = getAppUrl();

  if (!stripe) {
    return {
      ok: false,
      code: "stripe_not_configured",
      error: "stripe_not_configured",
      messageJa: "Stripe が設定されていません。",
      nextStepJa: "STRIPE_SECRET_KEY を設定してください。",
    };
  }

  let customerId = await getOrgStripeCustomerId(input.orgId);
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: input.actorEmail,
      metadata: {
        orgId: input.orgId,
        org_id: input.orgId,
        source: "external_contract_card_setup",
      },
    });
    customerId = customer.id;
    await setOrgStripeCustomerId(input.orgId, customerId);
  }

  const metadata: CardSetupSessionMetadata = {
    purpose: "payment_method_setup",
    orgId: input.orgId,
    approvalId: input.approvalId,
  };

  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    client_reference_id: input.orgId,
    success_url: `${appUrl}/app/billing/card-setup?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/app/billing/card-setup?status=canceled`,
    metadata,
    payment_method_types: ["card"],
    expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
  });

  const setupIntentId = session.setup_intent as string;

  const paymentMethod = await createPendingPaymentMethod({
    orgId: input.orgId,
    stripeSetupIntentId: setupIntentId,
    metadata: {
      checkoutSessionId: session.id,
      approvalId: input.approvalId,
    },
  });

  await recordCardAuditEvent({
    orgId: input.orgId,
    action: "link_minted",
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    approvalId: input.approvalId,
    stripeSessionId: session.id,
    outcome: "success",
    metadata: {
      expiresAt: new Date((session.expires_at || 0) * 1000).toISOString(),
    },
  });

  return {
    ok: true,
    sessionId: session.id,
    sessionUrl: session.url || "",
    setupIntentId,
    expiresAt: new Date((session.expires_at || 0) * 1000).toISOString(),
    paymentMethod,
  };
}

/**
 * Demo/stub response when Stripe is not configured.
 */
export function createCardSetupSessionStub(input: {
  orgId: string;
  approvalId: string;
}): CreateCardSetupSessionResult {
  const flagCheck = checkExternalContractCardSetupFlag();
  if (!flagCheck.enabled && flagCheck.error) {
    return {
      ok: false,
      code: flagCheck.error.code,
      error: flagCheck.error.error,
      messageJa: flagCheck.error.messageJa,
      nextStepJa: flagCheck.error.nextStepJa,
    };
  }

  if (isDemoMode()) {
    const sessionId = `cs_demo_setup_${Date.now()}`;
    const setupIntentId = `seti_demo_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    return {
      ok: true,
      sessionId,
      sessionUrl: `https://checkout.stripe.com/demo/setup/${sessionId}`,
      setupIntentId,
      expiresAt,
      paymentMethod: {
        id: `demo_pm_${Date.now()}`,
        orgId: input.orgId,
        stripePaymentMethodId: null,
        setupStatus: "pending",
        setupCompletedAt: null,
        setupCompletedBy: null,
        setupApprovalId: input.approvalId,
        stripeSetupIntentId: setupIntentId,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  return {
    ok: false,
    code: "stripe_not_configured",
    error: "stripe_not_configured",
    messageJa: "Stripe が設定されていません。",
    nextStepJa: "STRIPE_SECRET_KEY を設定してください。",
  };
}

/**
 * Build mouth-friendly response for deep link minting.
 * Returns short-lived link + nextStepJa (P0-A pattern).
 */
export function buildCardSetupMouthResponse(result: CreateCardSetupSessionResult): {
  ok: boolean;
  linkUrl?: string;
  expiresAt?: string;
  expiresInMinutes?: number;
  messageJa: string;
  nextStepJa: string;
} {
  if (!result.ok) {
    return {
      ok: false,
      messageJa: result.messageJa,
      nextStepJa: result.nextStepJa,
    };
  }

  const expiresInMinutes = 15;

  return {
    ok: true,
    linkUrl: result.sessionUrl,
    expiresAt: result.expiresAt,
    expiresInMinutes,
    messageJa: `カード登録リンクを発行しました。有効期限は${expiresInMinutes}分です。`,
    nextStepJa: "リンクをクリックしてStripeの安全なページでカード情報を入力してください。",
  };
}
