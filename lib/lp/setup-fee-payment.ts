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
 *   HMAC-SHA256(LP_CUSTOMER_EMAIL_HASH_KEY, normalised address) + the domain.
 *   Notice: the domain only. Key missing (木村 10/12 follow-up): the payment is
 *   still recorded WITHOUT the hash and the notice still goes out (saying the
 *   hash was not saved); operators get an alert (ids + reason code only) and the
 *   webhook answers 5xx so Stripe redelivers — the redelivery after the key is
 *   set back-fills the hash and does not notify again.
 * - Legacy Sessions with no lpPage (created before lpPage existed) are page A
 *   (DEFAULT_LP_PAGE); a present but invalid lpPage is still "(invalid)".
 * - Notice bookkeeping: the 'sent' / release write is retried in-process; a
 *   claim held by someone else that is not finished → 5xx (Stripe redelivers;
 *   after NOTICE_STALE_SECONDS the leftover claim is taken over and the notice
 *   is sent once, labelled as a possible resend). "duplicate" (200) only when
 *   the notice is recorded as done.
 * - No tenant, no org, no subscription row, no customer contact.
 */
import { createHmac, randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { REFERRAL_CODE_PATTERN } from "@/lib/auth/signup-guard";
import { VALID_CHECKOUT_PLANS } from "@/lib/lp/catalog";
import { DEFAULT_LP_PAGE, lpPageLabel, parseLpPage, parseLpRef } from "@/lib/lp/lp-page";
import type { LpEventType, LpPaymentRecord, LpProvisioningStore, NoticeResult } from "@/lib/lp/provisioning-store";
import { isLpEmailHashKeyConfigured, LP_EMAIL_HASH_KEY_ENV, requireLpEmailHashKey } from "@/lib/security/lp-email-hash-key";

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
  // Legacy Session (no lpPage key / empty) → page A; present but not allowlisted → marker.
  const lpPage = present(m.lpPage) ? parseLpPage(m.lpPage) ?? INVALID_MARKER : DEFAULT_LP_PAGE;
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

/** Keyed: HMAC-SHA256(key, trimmed lower-cased address). The key comes from requireLpEmailHashKey(). */
export function emailFingerprint(raw: unknown, key: string | null): { hmac: string | null; domain: string | null } {
  if (typeof raw !== "string") return { hmac: null, domain: null };
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return { hmac: null, domain: null };
  // No key → no hash at all (never an unkeyed digest); the domain is still kept.
  const hmac = key ? createHmac("sha256", key).update(email, "utf8").digest("hex") : null;
  const d = email.slice(at + 1);
  return { hmac, domain: DOMAIN.test(d) ? d : INVALID_MARKER };
}

export function formatLpAmount(amount: number, currency: string): string {
  const c = currency.toLowerCase();
  if (c === "jpy") return `¥${amount.toLocaleString("en-US")} (JPY)`;
  if (ZERO_DECIMAL.has(c)) return `${amount.toLocaleString("en-US")} ${c.toUpperCase()}`;
  return `${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c.toUpperCase()}`;
}

const shown = (v: string | null) => (v == null ? "なし" : v === INVALID_MARKER ? "不正な値（破棄）" : v);

export function lpSetupFeeNoticeText(
  rec: Omit<LpPaymentRecord, "customerEmailHmac">,
  opts: { emailHashSaved?: boolean; possibleResend?: boolean } = {}
): string {
  const page = parseLpPage(rec.lpPage);
  return [
    "【Staffpass LP】初期費用のお支払いを確認しました（記録と通知のみ）",
    ...(opts.possibleResend ? ["（再送: 前回の送信結果を記録できなかったため送り直しています。重複の可能性があります）"] : []),
    "",
    `金額: ${formatLpAmount(rec.amountTotal, rec.currency)}`,
    `プラン: ${shown(rec.plan)}`,
    `流入ページ: ${page ? lpPageLabel(page) : shown(INVALID_MARKER)}`,
    `紹介元(ref): ${shown(rec.lpRef)}`,
    `紹介コード: ${shown(rec.referralCode)}`,
    `注文ID: ${shown(rec.lpOrderId)}`,
    `メールのドメイン: ${shown(rec.customerEmailDomain)}`,
    ...(opts.emailHashSaved === false ? [`メールの照合用ハッシュ: 未保存（${LP_EMAIL_HASH_KEY_ENV} が未設定。運営に別途アラート済み）`] : []),
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
  s: Stripe.Checkout.Session,
  emailHashKey: string | null
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
  const fp = emailFingerprint(s.customer_details?.email ?? s.customer_email ?? null, emailHashKey);
  return {
    outcome: "paid",
    record: {
      stripeCheckoutSessionId: s.id,
      livemode: Boolean(s.livemode),
      amountTotal: s.amount_total,
      currency: s.currency,
      ...sanitizeLpSetupFeeMetadata(s.metadata),
      customerEmailHmac: fp.hmac,
      customerEmailDomain: fp.domain,
    },
  };
}

export interface LpNotifier {
  /** "sent" when at least one configured channel accepted it; "no_destination" when none is configured. */
  send(text: string, subject: string): Promise<"sent" | "no_destination" | "failed">;
}

export type LpOpsAlertKind = "email_hash_key_missing" | "notice_record_failed";

export interface LpSetupFeeDeps {
  retrieveSession(id: string): Promise<Stripe.Checkout.Session>;
  store: LpProvisioningStore;
  notifier: LpNotifier;
  /** Operators only; ids + reason code, never the customer email. Never throws. Defaults to notifyOpsLpSetupFee. */
  alertOps?: (a: { kind: LpOpsAlertKind; sessionId: string; eventId: string }) => Promise<void>;
  /** Test seam for the in-process retry back-off. */
  sleep?: (ms: number) => Promise<void>;
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
  // Same key rules as IP_HASH_KEY; missing → no hash (never unkeyed), but the
  // payment is still recorded and notified, then 5xx (see below).
  const emailHashKey = isLpEmailHashKeyConfigured() ? requireLpEmailHashKey() : null;
  const alertOps = deps.alertOps ?? notifyOpsLpSetupFee;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let session: Stripe.Checkout.Session;
  try {
    session = await deps.retrieveSession(sessionId);
  } catch (e) {
    if (isNotFound(e)) return ignore("session_not_found", null, null);
    throw new Error("lp_session_retrieve_failed");
  }

  const decision = decideLpSetupFeeSession(event, sessionId, session, emailHashKey);
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
  const recorded = await deps.store.recordPayment({ ...decision.record, firstStripeEventId: eventId });
  // Recorded earlier while the key was missing → back-fill (only where still null).
  // A failed write is NOT swallowed (木村 10/12, #344 follow-up): the notice flow
  // below still runs (dedupe keeps it to one), then we answer 5xx so Stripe
  // redelivers and the fill-in is tried again.
  let fillFailed = false;
  if (!recorded.inserted && decision.record.customerEmailHmac) {
    const hmac = decision.record.customerEmailHmac;
    fillFailed = true;
    for (let i = 0; i < FINISH_ATTEMPTS && fillFailed; i++) {
      try {
        await deps.store.fillEmailHmac(sessionId, hmac);
        fillFailed = false;
      } catch {
        if (i < FINISH_ATTEMPTS - 1) await sleep(FINISH_BACKOFF_MS[i] ?? 400);
      }
    }
  }
  const fillMissing = () => {
    console.error("[stripe:webhook:lp-setup-fee] email hash fill-in write failed; answering 5xx for redelivery", { eventId, sessionId });
    throw new Error("lp_email_hmac_fill_failed");
  };
  const keyMissing = async () => {
    console.error(`[stripe:webhook:lp-setup-fee] ${LP_EMAIL_HASH_KEY_ENV} not configured; recorded without the email hash, answering 5xx for redelivery`, { eventId, sessionId });
    await alertOps({ kind: "email_hash_key_missing", sessionId, eventId }).catch(() => undefined);
    throw new Error("lp_email_hash_key_missing");
  };

  // Once per Session, whichever event / delivery gets here first.
  const before = await deps.store.noticeState(sessionId);
  const token = randomBytes(18).toString("base64url");
  if (!(await deps.store.claimNotice(sessionId, token, NOTICE_STALE_SECONDS))) {
    const state = await deps.store.noticeState(sessionId);
    if (state === "done") {
      log("duplicate", { eventId, sessionId });
      if (!emailHashKey) await keyMissing();
      if (fillFailed) fillMissing();
      return { action: "duplicate", mode };
    }
    // Someone else's claim, not finished (in flight, or left over by a failed
    // release): never answer 200 here — Stripe redelivers, and once the claim is
    // stale the next delivery takes it over and sends.
    log("notice_in_flight", { eventId, sessionId, state });
    throw new Error("lp_notice_in_flight");
  }
  const text = lpSetupFeeNoticeText(decision.record, {
    emailHashSaved: emailHashKey ? undefined : false,
    possibleResend: before === "in_flight",
  });
  let result: "sent" | "no_destination" | "failed";
  try {
    result = await deps.notifier.send(text, "[Staffpass] LP 初期費用のお支払い（記録のみ）");
  } catch {
    result = "failed";
  }
  const finish = async (r: NoticeResult): Promise<boolean> => {
    for (let i = 0; i < FINISH_ATTEMPTS; i++) {
      try {
        await deps.store.finishNotice(sessionId, token, r);
        return true;
      } catch {
        if (i < FINISH_ATTEMPTS - 1) await sleep(FINISH_BACKOFF_MS[i] ?? 400);
      }
    }
    return false;
  };
  if (result === "failed") {
    // Release (retried). If the release write still fails the claim is left
    // over; the next delivery answers 5xx until it is stale, then takes it over.
    const released = await finish("failed");
    log("notice_failed", { eventId, sessionId, released });
    throw new Error("lp_notice_failed");
  }
  if (!(await finish(result))) {
    // Delivered, but 'sent' could not be recorded. Answer 200 (a 5xx would make
    // Stripe redeliver and, after the stale window, resend) and alert operators.
    console.error("[stripe:webhook:lp-setup-fee] notice delivered but not recorded", { eventId, sessionId });
    await alertOps({ kind: "notice_record_failed", sessionId, eventId }).catch(() => undefined);
  }
  log(result === "sent" ? "notified" : "no_destination", { eventId, sessionId });
  if (!emailHashKey) await keyMissing();
  if (fillFailed) fillMissing();
  return { action: result === "sent" ? "notified" : "no_destination", mode };
}

const FINISH_ATTEMPTS = 3;
const FINISH_BACKOFF_MS = [100, 400];

// ---------------------------------------------------------------------------
// Operator alert (existing ops channels: PLATFORM_OPS_ORG_ID audit mirror +
// APPROVAL_ALERT_OPS_EMAILS, same as notifyOpsDcrGlobalCapReached). Ids and a
// reason code only — no customer email, domain, name or amount. Throttled per
// kind × Session for 30 min per instance (Stripe redelivers for up to 3 days).
// ---------------------------------------------------------------------------
const OPS_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const OPS_ALERT_WINDOW_MS = 30 * 60_000;
const opsAlertThrottle = new Map<string, number>();
export function resetLpOpsAlertThrottleForTests(): void {
  opsAlertThrottle.clear();
}

const OPS_ALERT_TEXT: Record<LpOpsAlertKind, { subject: string; line: string; todo: string }> = {
  email_hash_key_missing: {
    subject: "【運営】LP 初期費用: LP_CUSTOMER_EMAIL_HASH_KEY が未設定です",
    line: "LP 初期費用の支払いを、メールの照合用ハッシュなしで記録しました（LP_CUSTOMER_EMAIL_HASH_KEY が未設定）。通知は送信済みです。Stripe には 5xx を返しているので、再送が続きます。",
    todo: "対処: LP_CUSTOMER_EMAIL_HASH_KEY を設定してください（openssl rand -hex 32）。設定後の Stripe の再送でハッシュが補われ、通知は二重に送られません。",
  },
  notice_record_failed: {
    subject: "【運営】LP 初期費用: 通知の送信記録に失敗しました",
    line: "LP 初期費用の通知は送信しましたが、送信済みの記録（lp_provisionings.notified_at）を DB に書けませんでした。",
    todo: "対処: DB の状態を確認してください。同じ Session に別のイベントが来ると、10 分後に「重複の可能性あり」と書いた通知がもう一度届くことがあります。",
  },
};

export async function notifyOpsLpSetupFee(a: { kind: LpOpsAlertKind; sessionId: string; eventId: string }): Promise<void> {
  try {
    const sessionId = SESSION_ID.test(a.sessionId) ? a.sessionId : "(invalid)";
    const eventId = EVENT_ID.test(a.eventId) ? a.eventId : "(invalid)";
    const key = `${a.kind}:${sessionId}`;
    const last = opsAlertThrottle.get(key);
    if (last != null && Date.now() - last < OPS_ALERT_WINDOW_MS) return;
    if (opsAlertThrottle.size > 2000) opsAlertThrottle.clear();
    opsAlertThrottle.set(key, Date.now());
    const t = OPS_ALERT_TEXT[a.kind];
    const ids = `Stripe Checkout Session: ${sessionId} / event: ${eventId}`;
    let reached = false;
    const opsOrgId = (process.env.PLATFORM_OPS_ORG_ID || "").trim();
    if (opsOrgId) {
      const { appendAuditEvent } = await import("@/lib/data/audit");
      reached = await appendAuditEvent({
        orgId: opsOrgId,
        employeeId: null,
        credentialId: null,
        action: `lp.setup_fee.${a.kind}` as const,
        purpose: null,
        summary: `${t.line} ${ids}`,
        metadata: { auditClass: "admin", event: `lp.setup_fee.${a.kind}`, stripeCheckoutSessionId: sessionId, stripeEventId: eventId },
      })
        .then(() => true)
        .catch(() => false);
    }
    const opsEmails = (process.env.APPROVAL_ALERT_OPS_EMAILS || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => OPS_EMAIL_RE.test(s))
      .slice(0, 10);
    if (opsEmails.length) {
      const { sendTransactionalEmail } = await import("@/lib/resend");
      const mailed = await sendTransactionalEmail({
        to: opsEmails,
        template: "lp_ops_alert",
        subject: t.subject,
        html: `<p>${escapeHtml(t.line)}</p><p>${escapeHtml(ids)}</p><p>${escapeHtml(t.todo)}</p>`,
        text: `${t.line}\n${ids}\n${t.todo}`,
        tags: [{ name: "template", value: "lp_ops_alert" }],
      })
        .then((r) => Boolean((r as { ok?: boolean })?.ok))
        .catch(() => false);
      reached = reached || mailed;
    }
    if (!reached) console.warn("[stripe:webhook:lp-setup-fee] ops alert undelivered", { kind: a.kind, sessionId });
  } catch {
    console.warn("[stripe:webhook:lp-setup-fee] ops alert error", { kind: a.kind });
  }
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
