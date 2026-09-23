/**
 * P1 External Contract Card Customer Portal Link
 *
 * Creates Stripe Customer Portal session for payment method change/delete.
 * Same mouth pattern as card setup link: short-lived link + nextStepJa.
 *
 * CRITICAL SECURITY CONSTRAINTS:
 * - always_human approval required for change/delete
 * - Feature flag checked before any operation
 * - NEVER log card data
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

import { getStripe, getAppUrl } from "@/lib/stripe";
import { getOrgStripeCustomerId } from "@/lib/data/subscriptions";
import { isDemoMode } from "@/lib/mode";
import { checkExternalContractCardSetupFlag } from "./feature-flag";
import { recordCardAuditEvent, getOrgPaymentMethod } from "./data";

export type PortalLinkResult =
  | {
      ok: true;
      portalUrl: string;
      expiresInMinutes: number;
    }
  | {
      ok: false;
      code: string;
      error: string;
      messageJa: string;
      nextStepJa: string;
    };

/**
 * Create a Stripe Customer Portal session for payment method management.
 *
 * IMPORTANT: This is called AFTER always_human approval is granted.
 *
 * @param orgId - Organization ID
 * @param approvalId - always_human approval ID (required)
 * @param actorUserId - User who initiated the portal access
 * @param actorEmail - Email of the user
 */
export async function createPortalLink(input: {
  orgId: string;
  approvalId: string;
  actorUserId?: string;
  actorEmail?: string;
}): Promise<PortalLinkResult> {
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

  const customerId = await getOrgStripeCustomerId(input.orgId);
  if (!customerId) {
    return {
      ok: false,
      code: "no_stripe_customer",
      error: "no_stripe_customer",
      messageJa: "Stripe 顧客が見つかりません。",
      nextStepJa: "先にカード登録を行ってください。",
    };
  }

  const existingPaymentMethod = await getOrgPaymentMethod(input.orgId);
  if (!existingPaymentMethod || existingPaymentMethod.setupStatus !== "completed") {
    return {
      ok: false,
      code: "no_payment_method",
      error: "no_payment_method",
      messageJa: "登録済みの支払い方法がありません。",
      nextStepJa: "先にカード登録を行ってください。",
    };
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/app/billing/card-setup?status=portal_return`,
  });

  await recordCardAuditEvent({
    orgId: input.orgId,
    action: "portal_link_minted",
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    approvalId: input.approvalId,
    outcome: "success",
  });

  return {
    ok: true,
    portalUrl: portal.url,
    expiresInMinutes: 5,
  };
}

/**
 * Demo/stub response when Stripe is not configured.
 */
export function createPortalLinkStub(input: {
  orgId: string;
  approvalId: string;
}): PortalLinkResult {
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
    return {
      ok: true,
      portalUrl: `https://billing.stripe.com/demo/portal/${input.orgId}`,
      expiresInMinutes: 5,
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
 * Build mouth-friendly response for portal link.
 * Returns short-lived link + nextStepJa (P0-A pattern).
 */
export function buildPortalLinkMouthResponse(result: PortalLinkResult): {
  ok: boolean;
  linkUrl?: string;
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

  return {
    ok: true,
    linkUrl: result.portalUrl,
    expiresInMinutes: result.expiresInMinutes,
    messageJa: `支払い方法管理リンクを発行しました。有効期限は${result.expiresInMinutes}分です。`,
    nextStepJa:
      "リンクをクリックしてStripeの安全なポータルで支払い方法の変更・削除を行ってください。",
  };
}
