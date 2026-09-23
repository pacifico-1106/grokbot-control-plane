/**
 * P1 External Contract Card Registration Module
 *
 * CRITICAL SECURITY CONSTRAINTS (non-negotiable):
 * - NEVER store or log PAN, CVV, expiry, card_fingerprint
 * - Stripe-hosted only (Checkout mode=setup + Customer Portal)
 * - Feature flag EXTERNAL_CONTRACT_CARD_SETUP must be OFF by default
 * - always_human approval required for bind/change/delete
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

export * from "./types";
export * from "./feature-flag";
export * from "./data";
export * from "./checkout-setup";
export * from "./portal-link";
export * from "./queue-card-setup";
export * from "./queue-portal-link";
export * from "./webhook-handler";
