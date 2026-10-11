/**
 * LP setup-fee payment → record + notify (design 2026-10-12 PR3, dry-run only).
 * LP_AUTO_PROVISION_MODE=dry_run (default off). Called from the Stripe webhook
 * AFTER signature verification and the event-id ledger claim.
 *
 * - The decision uses ONLY the Checkout Session re-fetched from Stripe by id
 *   (never the event payload): LP source, no org claim, mode=payment,
 *   status=complete, payment_status=paid, livemode = event's.
 * - Dedupe: lp_provisioning_events (UNIQUE event id) + lp_provisionings
 *   (UNIQUE Session id) + a notice claim (conditional UPDATE, claim token) so a
 *   replay, a second event for the same Session or a concurrent delivery never
 *   notifies twice. A notice that failed on every channel releases its claim and
 *   the webhook answers 5xx so Stripe retries.
 * - Metadata is re-validated (lpPage allowlist, lpRef / AIC- / plan / uuid);
 *   invalid values become "(invalid)", never raw.
 * - Customer email: never logged, never stored, never in the notice. Stored:
 *   sha256 of the normalised address + the domain. Notice: the domain only.
 * - No tenant, no org, no subscription row, no customer contact.
 */
import { createHash, randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { REFERRAL_CODE_PATTERN } from "@/lib/auth/signup-guard";
import { VALID_CHECKOUT_PLANS } from "@/lib/lp/catalog";
import { lpPageLabel, parseLpPage, parseLpRef } from "@/lib/lp/lp-page";
import type { LpEventType, LpPaymentRecord, LpProvisioningStore } from "@/lib/lp/provisioning-store";

export const LP_SOURCE = "lp-ai-employee";
export const INVALID_MARKER = "(invalid)";
export const LP_EVENT_TYPES: readonly LpEventType[] = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
];
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,255}$/;
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = /^[a-z0-9.-]{1,253}$/;
const CURRENCY = /^[a-z]{3}$/;
const ZERO_DECIMAL = new Set(["jpy", "krw", "vnd", "clp", "pyg", "ugx", "xaf", "xof", "bif", "djf", "gnf", "kmf", "mga", "rwf", "vuv", "xpf"]);
const NOTICE_STALE_SECONDS = 600;

type Meta = Record<string, unknown> | null | undefined;

export function isLpSetupFeeEventType(type: string): type is LpEventType {
  return (LP_EVENT_TYPES as readonly string[]).includes(type);
}

/** Routing hint from the (signed) payload only; the decision re-checks the re-fetched Session. */
export function looksLikeLpSetupFeeSession(session: { metadata?: Meta; client_reference_id?: string | null } | null | undefined): boolean {
  if (!session) return false;
  return session.metadata?.source === LP_SOURCE && !hasOrgClaim(session);
}

function hasOrgClaim(session: { metadata?: Meta; client_reference_id?: string | null }): boolean {
  const m = session.metadata ?? {};
  return [session.client_reference_id, m.orgId, m.org_id].some((v) => v != null && String(v).trim() !== "");
}

export function sanitizeLpSetupFeeMetadata(meta: Meta): Pick<LpPaymentRecord, "plan" | "lpPage" | "lpRef" | "referralCode" | "lpOrderId"> {
  const m = meta ?? {};
  const present = (v: unknown) => v != null && v !== "";
  const plan = typeof m.plan === "string" && (VALID_CHECKOUT_PLANS as readonly string[]).includes(m.plan) ? m.plan : INVALID_MARKER;
  const lpPage = parseLpPage(m.lpPage) ?? INVALID_MARKER;
  const lpRef = present(m.lpRef) ? parseLpRef(m.lpRef) ?? INVALID_MARKER : null;
  let referralCode: string | null = null;
  if (present(m.referralCode)) {
    const v = typeof m.referralCode === "string" ? m.referralCode.trim().toUpperCase() : "";
    referralCode = REFERRAL_CODE_PATTERN.test(v) ? v : INVALID_MARKER;
  }
  const rawOrder = m.lpOrderId ?? m.orderId;
  const lpOrderId = present(rawOrder) ? (typeof rawOrder === "string" && UUID.test(rawOrder) ? rawOrder : INVALID_MARKER) : null;
  return { plan, lpPage, lpRef, referralCode, lpOrderId };
}

export function emailFingerprint(raw: unknown): { sha256: string | null; domain: string | null } {
  if (typeof raw !== "string") return { sha256: null, domain: null };
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return { sha256: null, domain: null };
  const sha256 = createHash("sha256").update(email, "utf8").digest("hex");
  const d = email.slice(at + 1);
  return { sha256, domain: DOMAIN.test(d) ? d : INVALID_MARKER };
}

export function formatLpAmount(amount: number, currency: string): string {
  const c = currency.toLowerCase();
  if (c === "jpy") return `¥${amount.toLocaleString("en-US")} (JPY)`;
  if (ZERO_DECIMAL.has(c)) return `${amount.toLocaleString("en-US")} ${c.toUpperCase()}`;
  return `${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c.toUpperCase()}`;
}

const shown = (v: string | null) => (v == null ? "なし" : v === INVALID_MARKER ? "不正な値（破棄）" : v);

export function lpSetupFeeNoticeText(rec: Omit<LpPaymentRecord, "customerEmailSha256">): string {
  const page = parseLpPage(rec.lpPage);
  return [
    "【Staffpass LP】初期費用のお支払いを確認しました（記録と通知のみ）",
    "",
    `金額: ${formatLpAmount(rec.amountTotal, rec.currency)}`,
    `プラン: ${shown(rec.plan)}`,
    `流入ページ: ${page ? lpPageLabel(page) : shown(INVALID_MARKER)}`,
    `紹介元(ref): ${shown(rec.lpRef)}`,
    `紹介コード: ${shown(rec.referralCode)}`,
    `注文ID: ${shown(rec.lpOrderId)}`,
    `メールのドメイン: ${shown(rec.customerEmailDomain)}`,
    `Stripe Checkout Session: ${rec.stripeCheckoutSessionId}${rec.livemode ? "" : "（テストモード）"}`,
    "",
    "dry-run のため、テナントは作成していません。お客さまへの連絡・テナント開設は手動で行ってください（メールアドレスは Stripe ダッシュボードの Session で確認）。",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type LpDecision =
  | { outcome: "paid"; record: LpPaymentRecord }
  | { outcome: "ignored"; reason: string };

export function decideLpSetupFeeSession(
  event: { type: string; livemode: boolean },
  sessionId: string,
  s: Stripe.Checkout.Session
): LpDecision {
  const ignored = (reason: string): LpDecision => ({ outcome: "ignored", reason });
  if (event.type === "checkout.session.async_payment_failed") return ignored("async_payment_failed");
  if (!s || s.id !== sessionId) return ignored("session_id_mismatch");
  if (s.metadata?.source !== LP_SOURCE) return ignored("not_lp_session");
  if (hasOrgClaim(s)) return ignored("has_org_claim");
  if (s.mode !== "payment") return ignored("unsupported_mode");
  if (Boolean(s.livemode) !== Boolean(event.livemode)) return ignored("livemode_mismatch");
  if (s.status !== "complete") return ignored("session_not_complete");
  if (s.payment_status !== "paid") return ignored("session_unpaid");
  if (typeof s.amount_total !== "number" || !Number.isSafeInteger(s.amount_total) || s.amount_total < 0) return ignored("invalid_amount");
  if (typeof s.currency !== "string" || !CURRENCY.test(s.currency)) return ignored("invalid_currency");
  const fp = emailFingerprint(s.customer_details?.email ?? s.customer_email ?? null);
  return {
    outcome: "paid",
    record: {
      stripeCheckoutSessionId: s.id,
      livemode: Boolean(s.livemode),
      amountTotal: s.amount_total,
      currency: s.currency,
      ...sanitizeLpSetupFeeMetadata(s.metadata),
      customerEmailSha256: fp.sha256,
      customerEmailDomain: fp.domain,
    },
  };
}

export interface LpNotifier {
  /** "sent" when at least one configured channel accepted it; "no_destination" when none is configured. */
  send(text: string, subject: string): Promise<"sent" | "no_destination" | "failed">;
}

export interface LpSetupFeeDeps {
  retrieveSession(id: string): Promise<Stripe.Checkout.Session>;
  store: LpProvisioningStore;
  notifier: LpNotifier;
}

export type LpSetupFeeResult =
  | { action: "notified" | "duplicate" | "no_destination"; mode: "dry_run" }
  | { action: "ignored"; reason: string; mode: "dry_run" };

function isNotFound(e: unknown): boolean {
  const err = e as { statusCode?: number; code?: string } | null;
  return Boolean(err && (err.statusCode === 404 || err.code === "resource_missing"));
}

const log = (msg: string, fields: Record<string, unknown>) => console.info(`[stripe:webhook:lp-setup-fee] ${msg}`, fields);

/**
 * Throws on transient failure (Stripe API, DB, every notice channel failed) →
 * the webhook answers 5xx and Stripe retries. Ignored outcomes are permanent.
 */
export async function handleLpSetupFeeEvent(
  event: { id: string; type: LpEventType; livemode: boolean; data: { object: unknown } },
  deps: LpSetupFeeDeps
): Promise<LpSetupFeeResult> {
  const mode = "dry_run" as const;
  const payload = event.data.object as { id?: unknown } | null;
  const sessionId = typeof payload?.id === "string" && SESSION_ID.test(payload.id) ? payload.id : null;
  const eventId = EVENT_ID.test(event.id) ? event.id : null;
  if (!eventId) {
    log("ignored", { reason: "invalid_event_id" });
    return { action: "ignored", reason: "invalid_event_id", mode };
  }
  const ignore = async (reason: string, paymentStatus: string | null, livemode: boolean | null): Promise<LpSetupFeeResult> => {
    await deps.store.recordEvent({
      stripeEventId: eventId,
      stripeCheckoutSessionId: sessionId,
      eventType: event.type,
      outcome: "ignored",
      reason,
      paymentStatus: paymentStatus && ["paid", "unpaid", "no_payment_required"].includes(paymentStatus) ? paymentStatus : null,
      livemode,
    });
    log("ignored", { eventId, sessionId, reason });
    return { action: "ignored", reason, mode };
  };
  if (!sessionId) return ignore("invalid_session_id", null, null);

  let session: Stripe.Checkout.Session;
  try {
    session = await deps.retrieveSession(sessionId);
  } catch (e) {
    if (isNotFound(e)) return ignore("session_not_found", null, null);
    throw new Error("lp_session_retrieve_failed");
  }

  const decision = decideLpSetupFeeSession(event, sessionId, session);
  if (decision.outcome === "ignored") {
    return ignore(decision.reason, typeof session?.payment_status === "string" ? session.payment_status : null, Boolean(session?.livemode));
  }

  await deps.store.recordEvent({
    stripeEventId: eventId,
    stripeCheckoutSessionId: sessionId,
    eventType: event.type,
    outcome: "paid",
    reason: null,
    paymentStatus: "paid",
    livemode: decision.record.livemode,
  });
  await deps.store.recordPayment({ ...decision.record, firstStripeEventId: eventId });

  // Once per Session, whichever event / delivery gets here first.
  const token = randomBytes(18).toString("base64url");
  if (!(await deps.store.claimNotice(sessionId, token, NOTICE_STALE_SECONDS))) {
    log("duplicate", { eventId, sessionId });
    return { action: "duplicate", mode };
  }
  const text = lpSetupFeeNoticeText(decision.record);
  let result: "sent" | "no_destination" | "failed";
  try {
    result = await deps.notifier.send(text, "[Staffpass] LP 初期費用のお支払い（記録のみ）");
  } catch {
    result = "failed";
  }
  if (result === "failed") {
    await deps.store.finishNotice(sessionId, token, "failed").catch(() => false);
    log("notice_failed", { eventId, sessionId });
    throw new Error("lp_notice_failed");
  }
  await deps.store.finishNotice(sessionId, token, result);
  log(result === "sent" ? "notified" : "no_destination", { eventId, sessionId });
  return { action: result === "sent" ? "notified" : "no_destination", mode };
}

/** 安藤 / operators: the LP handoff Slack webhook + BILLING_NOTIFY_EMAIL (design §3-7). */
export function createLpSetupFeeNotifier(deps: {
  sendEmail: (to: string, subject: string, html: string) => Promise<{ ok?: boolean } | unknown>;
  fetchImpl?: typeof fetch;
}): LpNotifier {
  return {
    async send(text, subject) {
      const slack = process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK;
      const email = process.env.BILLING_NOTIFY_EMAIL;
      if (!slack && !email) {
        console.warn("[stripe:webhook:lp-setup-fee] no notice destination configured (LP_HANDOFF_NOTIFY_SLACK_WEBHOOK / BILLING_NOTIFY_EMAIL)");
        return "no_destination";
      }
      let any = false;
      if (slack) {
        try {
          const res = await (deps.fetchImpl ?? fetch)(slack, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
          });
          if (res.ok) any = true;
          else console.warn("[stripe:webhook:lp-setup-fee] slack notice failed", { status: res.status });
        } catch {
          console.warn("[stripe:webhook:lp-setup-fee] slack notice error");
        }
      }
      if (email) {
        try {
          const r = (await deps.sendEmail(email, subject, `<pre>${escapeHtml(text)}</pre>`)) as { ok?: boolean } | undefined;
          if (r && r.ok) any = true;
          else console.warn("[stripe:webhook:lp-setup-fee] email notice failed");
        } catch {
          console.warn("[stripe:webhook:lp-setup-fee] email notice error");
        }
      }
      return any ? "sent" : "failed";
    },
  };
}
