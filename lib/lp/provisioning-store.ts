/**
 * LP setup-fee payment record (PR3 dry-run, migration 20261012400000).
 * Production: Supabase service role (PostgREST insert … on conflict do nothing
 * + the two notice RPCs). Tests: an in-memory store with the same semantics.
 * Ids, codes and re-validated values only; never the customer email.
 */
import { createSupabaseAdminClient } from "@/lib/supabase";

export type LpEventType =
  | "checkout.session.completed"
  | "checkout.session.async_payment_succeeded"
  | "checkout.session.async_payment_failed";

export interface LpProvisioningEventRow {
  stripeEventId: string;
  stripeCheckoutSessionId: string | null;
  eventType: LpEventType;
  outcome: "paid" | "ignored";
  reason: string | null;
  paymentStatus: string | null;
  livemode: boolean | null;
}

export interface LpPaymentRecord {
  stripeCheckoutSessionId: string;
  livemode: boolean;
  amountTotal: number;
  currency: string;
  plan: string;
  lpPage: string;
  lpRef: string | null;
  referralCode: string | null;
  lpOrderId: string | null;
  customerEmailHmac: string | null;
  customerEmailDomain: string | null;
}

export interface LpPaymentRow extends LpPaymentRecord {
  firstStripeEventId: string;
  noticeClaimToken: string | null;
  noticeClaimedAt: number | null;
  noticeResult: "sent" | "no_destination" | null;
}

export type NoticeResult = "sent" | "no_destination" | "failed";

export interface LpProvisioningStore {
  /** Insert-if-absent by Stripe event id. inserted=false → replay of an event already seen. */
  recordEvent(row: LpProvisioningEventRow): Promise<{ inserted: boolean }>;
  /** Insert-if-absent by Checkout Session id. inserted=false → a second event for the same Session. */
  recordPayment(row: LpPaymentRecord & { firstStripeEventId: string }): Promise<{ inserted: boolean }>;
  claimNotice(sessionId: string, token: string, staleSeconds: number): Promise<boolean>;
  finishNotice(sessionId: string, token: string, result: NoticeResult): Promise<boolean>;
}

export function createMemoryLpProvisioningStore() {
  const events = new Map<string, LpProvisioningEventRow>();
  const payments = new Map<string, LpPaymentRow>();
  const store: LpProvisioningStore & { events: typeof events; payments: typeof payments } = {
    events,
    payments,
    async recordEvent(row) {
      if (events.has(row.stripeEventId)) return { inserted: false };
      events.set(row.stripeEventId, { ...row });
      return { inserted: true };
    },
    async recordPayment(row) {
      if (payments.has(row.stripeCheckoutSessionId)) return { inserted: false };
      payments.set(row.stripeCheckoutSessionId, { ...row, noticeClaimToken: null, noticeClaimedAt: null, noticeResult: null });
      return { inserted: true };
    },
    async claimNotice(sessionId, token, staleSeconds) {
      if (!token || token.length < 16) throw new Error("invalid_claim_token");
      const p = payments.get(sessionId);
      if (!p || p.noticeResult) return false;
      if (p.noticeClaimToken && p.noticeClaimedAt != null && p.noticeClaimedAt >= Date.now() - staleSeconds * 1000) return false;
      p.noticeClaimToken = token;
      p.noticeClaimedAt = Date.now();
      return true;
    },
    async finishNotice(sessionId, token, result) {
      const p = payments.get(sessionId);
      if (!p || p.noticeResult || !token || p.noticeClaimToken !== token) return false;
      p.noticeClaimToken = null;
      if (result === "failed") {
        p.noticeClaimedAt = null;
      } else {
        p.noticeResult = result;
      }
      return true;
    },
  };
  return store;
}

/** null when Supabase is not configured (the caller fails closed: 5xx, Stripe retries). */
export function createSupabaseLpProvisioningStore(): LpProvisioningStore | null {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  return {
    async recordEvent(row) {
      const { data, error } = await admin
        .from("lp_provisioning_events")
        .upsert(
          {
            stripe_event_id: row.stripeEventId,
            stripe_checkout_session_id: row.stripeCheckoutSessionId,
            event_type: row.eventType,
            outcome: row.outcome,
            reason: row.reason,
            payment_status: row.paymentStatus,
            livemode: row.livemode,
          },
          { onConflict: "stripe_event_id", ignoreDuplicates: true }
        )
        .select("id");
      if (error) throw new Error("lp_event_record_failed");
      return { inserted: Array.isArray(data) && data.length > 0 };
    },
    async recordPayment(row) {
      const { data, error } = await admin
        .from("lp_provisionings")
        .upsert(
          {
            stripe_checkout_session_id: row.stripeCheckoutSessionId,
            first_stripe_event_id: row.firstStripeEventId,
            livemode: row.livemode,
            mode: "dry_run",
            amount_total: row.amountTotal,
            currency: row.currency,
            plan: row.plan,
            lp_page: row.lpPage,
            lp_ref: row.lpRef,
            referral_code: row.referralCode,
            lp_order_id: row.lpOrderId,
            customer_email_hmac: row.customerEmailHmac,
            customer_email_domain: row.customerEmailDomain,
          },
          { onConflict: "stripe_checkout_session_id", ignoreDuplicates: true }
        )
        .select("id");
      if (error) throw new Error("lp_payment_record_failed");
      return { inserted: Array.isArray(data) && data.length > 0 };
    },
    async claimNotice(sessionId, token, staleSeconds) {
      const { data, error } = await admin.rpc("claim_lp_provisioning_notice", {
        p_session: sessionId,
        p_token: token,
        p_stale_seconds: staleSeconds,
      });
      if (error) throw new Error("lp_notice_claim_failed");
      return data === true;
    },
    async finishNotice(sessionId, token, result) {
      const { data, error } = await admin.rpc("finish_lp_provisioning_notice", {
        p_session: sessionId,
        p_token: token,
        p_result: result,
      });
      if (error) throw new Error("lp_notice_finish_failed");
      return data === true;
    },
  };
}
