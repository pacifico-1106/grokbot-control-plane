/**
 * P1 External Contract Card Registration Types
 *
 * CRITICAL: These types must NEVER include PAN, CVV, expiry, or card_fingerprint.
 * Only token references (stripe_payment_method_id) and audit metadata are allowed.
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

/**
 * Payment method setup status lifecycle.
 */
export type PaymentMethodSetupStatus =
  | "pending"
  | "completed"
  | "failed"
  | "removed";

/**
 * External contract payment method registration record.
 * Stores only token references — card details remain in Stripe.
 */
export interface ExternalContractPaymentMethod {
  id: string;
  orgId: string;
  stripePaymentMethodId: string | null;
  setupStatus: PaymentMethodSetupStatus;
  setupCompletedAt: string | null;
  setupCompletedBy: string | null;
  setupApprovalId: string | null;
  stripeSetupIntentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Card setup audit action types.
 */
export type CardAuditAction =
  | "link_minted"
  | "link_opened"
  | "setup_completed"
  | "setup_failed"
  | "setup_expired"
  | "portal_link_minted"
  | "portal_opened"
  | "method_changed"
  | "method_removed"
  | "card_like_string_blocked";

/**
 * Card setup audit event outcome.
 */
export type CardAuditOutcome =
  | "success"
  | "failure"
  | "expired"
  | "blocked"
  | null;

/**
 * Card setup audit event record.
 * CRITICAL: metadata must NEVER contain PAN/CVV/expiry/fingerprint.
 */
export interface ExternalContractCardAuditEvent {
  id: string;
  orgId: string;
  action: CardAuditAction;
  actorUserId: string | null;
  actorEmail: string | null;
  approvalId: string | null;
  stripeSessionId: string | null;
  outcome: CardAuditOutcome;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Input for creating a payment method record.
 */
export interface CreatePaymentMethodInput {
  orgId: string;
  stripeSetupIntentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for completing a payment method setup.
 */
export interface CompletePaymentMethodInput {
  orgId: string;
  stripePaymentMethodId: string;
  stripeSetupIntentId: string;
  setupCompletedBy?: string;
  setupApprovalId: string;
}

/**
 * Input for recording a card audit event.
 * CRITICAL: metadata must NEVER contain PAN/CVV/expiry/fingerprint.
 */
export interface RecordCardAuditInput {
  orgId: string;
  action: CardAuditAction;
  actorUserId?: string | null;
  actorEmail?: string | null;
  approvalId?: string | null;
  stripeSessionId?: string | null;
  outcome?: CardAuditOutcome;
  metadata?: Record<string, unknown>;
}
