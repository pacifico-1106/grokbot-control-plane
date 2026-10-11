/**
 * PR3 dry-run (木村 2026-10-12): LP setup-fee payment → record + notify 安藤 /
 * operators, behind LP_AUTO_PROVISION_MODE=dry_run (default off). No tenant.
 * Route-level security tests: signature, paid only (from the re-fetched
 * Session), event + Session dedupe, invalid metadata, flag OFF, no raw email in logs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import type StripeType from "stripe";
// @ts-expect-error -- direct file import of the node build (no type entry)
import StripeNodeBuild from "../../../../node_modules/stripe/esm/stripe.esm.node.js";
const Stripe = StripeNodeBuild as unknown as typeof StripeType;
import * as realStripeModule from "@/lib/stripe";
import * as realLedgerModule from "@/lib/billing/stripe-webhook-ledger";
import * as realGuardModule from "@/lib/billing/stripe-customer-org-guard";
import * as realStoreModule from "@/lib/lp/provisioning-store";

const realStripe = { ...realStripeModule };
const realLedger = { ...realLedgerModule };
const realGuard = { ...realGuardModule };
const realStore = { ...realStoreModule };

const SECRET = "whsec_test_secret_for_lp_tests";
const EMAIL = "Hanako.Suzuki@Customer-Corp.co.jp";
const SLACK = "https://hooks.slack.test/services/T/B/lp";
const EMAIL_KEY = "lp-email-hash-key-route-fixture-0123456789";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const stripe = new Stripe("sk_test_unit_dummy", { typescript: true });
let sessionImpl: (id: string) => Promise<unknown> = async () => {
  throw new Error("not stubbed");
};
const sessionRetrieves: string[] = [];
(stripe.checkout.sessions as unknown as { retrieve: unknown }).retrieve = (id: string) => {
  sessionRetrieves.push(id);
  return sessionImpl(id);
};
(stripe.subscriptions as unknown as { retrieve: unknown }).retrieve = async () => {
  throw new Error("subscriptions.retrieve not expected");
};

mock.module("@/lib/stripe", () => ({ ...realStripe, getStripe: () => stripe }));
mock.module("@/lib/mode", () => ({ isDemoMode: () => false, isStripeConfigured: () => true }));
const upserts: unknown[] = [];
mock.module("@/lib/data/subscriptions", () => ({ upsertSubscription: async (i: unknown) => void upserts.push(i) }));
const emails: Array<{ to: string; subject: string; body: string }> = [];
let emailOk = true;
mock.module("@/lib/email", () => ({
  sendBillingEmail: async (to: string, subject: string, body: string) => {
    emails.push({ to, subject, body });
    return { ok: emailOk };
  },
  sendTrialEndingEmail: async () => ({ ok: true }),
}));
mock.module("@/lib/billing/stripe-plan-webhook", () => ({ processSubscriptionForPlanChange: async () => ({ processed: true }) }));
mock.module("@/lib/external-contract-card/webhook-handler", () => ({
  processCardSetupWebhook: async () => ({ processed: true, eventType: "unknown", action: "ignored", orgId: null }),
}));
mock.module("@/lib/data/audit", () => ({ appendAuditEvent: async () => undefined }));
let ledger = realLedger.createMemoryStripeWebhookEventStore();
let ledgerOverride: realLedgerModule.StripeWebhookEventStore | null | undefined;
mock.module("@/lib/billing/stripe-webhook-ledger", () => ({
  ...realLedger,
  createSupabaseStripeWebhookEventStore: () => (ledgerOverride !== undefined ? ledgerOverride : ledger),
}));
mock.module("@/lib/billing/stripe-customer-org-guard", () => ({
  ...realGuard,
  createSupabaseLinkedOrgLookup: () => async () => [],
}));
let lpStore = realStore.createMemoryLpProvisioningStore();
mock.module("@/lib/lp/provisioning-store", () => ({ ...realStore, createSupabaseLpProvisioningStore: () => lpStore }));

const slackPosts: Array<{ url: string; body: string }> = [];
let slackOk = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  slackPosts.push({ url: String(url), body: String(init?.body ?? "") });
  return new Response(slackOk ? "ok" : "no", { status: slackOk ? 200 : 500 });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const logs: string[] = [];
const origConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
function captureConsole() {
  for (const k of Object.keys(origConsole) as Array<keyof typeof origConsole>) {
    console[k] = (...args: unknown[]) => void logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
}
function restoreConsole() {
  Object.assign(console, origConsole);
}

const { POST } = await import("./route");

let seq = 0;
function lpSession(over: Record<string, unknown> = {}) {
  return {
    id: "cs_test_lp1",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    livemode: false,
    amount_total: 165000,
    currency: "jpy",
    client_reference_id: null,
    customer: null,
    subscription: null,
    customer_details: { email: EMAIL, name: "鈴木 花子" },
    metadata: { source: "lp-ai-employee", plan: "proper", lpPage: "ai-employee-corp", lpRef: "partner_01", referralCode: "AIC-ABCD1234", setupYen: "150000" },
    ...over,
  };
}
function makeEvent(type: string, object: Record<string, unknown>, id?: string) {
  return {
    id: id ?? `evt_lp_${++seq}`, object: "event", type, api_version: "2025-08-27.basil", created: 1790000000, livemode: false,
    pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object },
  };
}
function signed(event: unknown, opts: { badSignature?: boolean; noSignature?: boolean } = {}) {
  const payload = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.noSignature) {
    headers["stripe-signature"] = stripe.webhooks.generateTestHeaderString({ payload, secret: opts.badSignature ? "whsec_wrong" : SECRET });
  }
  return new Request("https://staffpass.example/api/webhooks/stripe", { method: "POST", headers, body: payload });
}
const noticesSent = () => slackPosts.length + emails.length;

beforeEach(() => {
  process.env.LP_AUTO_PROVISION_MODE = "dry_run";
  process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = SLACK;
  process.env.BILLING_NOTIFY_EMAIL = "ops@staffpass.example";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.LP_CUSTOMER_EMAIL_HASH_KEY = EMAIL_KEY;
  ledger = realLedger.createMemoryStripeWebhookEventStore();
  ledgerOverride = undefined;
  lpStore = realStore.createMemoryLpProvisioningStore();
  sessionRetrieves.length = 0;
  slackPosts.length = 0;
  emails.length = 0;
  upserts.length = 0;
  logs.length = 0;
  slackOk = true;
  emailOk = true;
  sessionImpl = async () => lpSession();
  captureConsole();
});
afterEach(() => {
  restoreConsole();
  // No raw customer email in any log line, for every test.
  for (const line of logs) {
    expect(line.toLowerCase()).not.toContain("hanako");
    expect(line.toLowerCase()).not.toContain("customer-corp");
  }
  delete process.env.LP_AUTO_PROVISION_MODE;
});

describe("signature", () => {
  test("bad signature → 400; no Stripe fetch, no record, no notice", async () => {
    const res = await POST(signed(makeEvent("checkout.session.completed", lpSession()), { badSignature: true }));
    expect(res.status).toBe(400);
    expect(sessionRetrieves).toEqual([]);
    expect(lpStore.events.size + lpStore.payments.size).toBe(0);
    expect(noticesSent()).toBe(0);
  });
  test("missing signature → 400; nothing processed", async () => {
    const res = await POST(signed(makeEvent("checkout.session.completed", lpSession()), { noSignature: true }));
    expect(res.status).toBe(400);
    expect(sessionRetrieves).toEqual([]);
    expect(noticesSent()).toBe(0);
  });
  test("no webhook secret configured (stub) → nothing processed, nothing recorded", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await POST(signed(makeEvent("checkout.session.completed", lpSession())));
    expect((await res.json()).stub).toBe(true);
    expect(sessionRetrieves).toEqual([]);
    expect(lpStore.payments.size).toBe(0);
    expect(noticesSent()).toBe(0);
  });
});

describe("paid → record + notify once", () => {
  test("paid session: re-fetched by id, one payment row, one Slack + one email with amount/currency, lpPage, lpRef, AIC-, Session ID", async () => {
    const evt = makeEvent("checkout.session.completed", lpSession());
    const res = await POST(signed(evt));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lpSetupFee).toEqual({ action: "notified", mode: "dry_run" });
    expect(sessionRetrieves).toEqual(["cs_test_lp1"]);
    expect(lpStore.payments.size).toBe(1);
    const row = lpStore.payments.get("cs_test_lp1")!;
    expect(row).toMatchObject({ amountTotal: 165000, currency: "jpy", lpPage: "ai-employee-corp", lpRef: "partner_01", referralCode: "AIC-ABCD1234", customerEmailDomain: "customer-corp.co.jp", noticeResult: "sent" });
    expect(row.customerEmailHmac).toBe(createHmac("sha256", EMAIL_KEY).update(EMAIL.toLowerCase(), "utf8").digest("hex"));
    expect(JSON.stringify(row).toLowerCase()).not.toContain("hanako");
    expect(lpStore.events.get(evt.id)).toMatchObject({ outcome: "paid", stripeCheckoutSessionId: "cs_test_lp1" });
    expect(slackPosts).toHaveLength(1);
    expect(slackPosts[0].url).toBe(SLACK);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("ops@staffpass.example");
    for (const text of [JSON.parse(slackPosts[0].body).text as string, emails[0].body]) {
      for (const s of ["¥165,000 (JPY)", "/lp/ai-employee-corp", "partner_01", "AIC-ABCD1234", "cs_test_lp1", "テナントは作成していません"]) expect(text).toContain(s);
      expect(text.toLowerCase()).not.toContain("hanako");
    }
    expect(upserts).toHaveLength(0); // no tenant / subscription writes
  });
  test("async_payment_succeeded (bank transfer) for a paid session is handled the same way", async () => {
    const res = await POST(signed(makeEvent("checkout.session.async_payment_succeeded", lpSession())));
    expect((await res.json()).lpSetupFee.action).toBe("notified");
    expect(noticesSent()).toBe(2);
  });
});

describe("not paid → recorded as ignored, never notified", () => {
  test("unpaid session (bank transfer pending) → ignored session_unpaid, no payment row, no notice", async () => {
    sessionImpl = async () => lpSession({ payment_status: "unpaid" });
    const evt = makeEvent("checkout.session.completed", lpSession({ payment_status: "unpaid" }));
    const body = await (await POST(signed(evt))).json();
    expect(body.lpSetupFee).toEqual({ action: "ignored", reason: "session_unpaid", mode: "dry_run" });
    expect(lpStore.events.get(evt.id)).toMatchObject({ outcome: "ignored", reason: "session_unpaid", paymentStatus: "unpaid" });
    expect(lpStore.payments.size).toBe(0);
    expect(noticesSent()).toBe(0);
  });
  test("payload says paid but the re-fetched Session says unpaid → ignored, no notice", async () => {
    sessionImpl = async () => lpSession({ payment_status: "unpaid" });
    const body = await (await POST(signed(makeEvent("checkout.session.completed", lpSession({ payment_status: "paid" }))))).json();
    expect(body.lpSetupFee.reason).toBe("session_unpaid");
    expect(lpStore.payments.size).toBe(0);
    expect(noticesSent()).toBe(0);
  });
  test("payload amount / metadata are never used: the record has the re-fetched values", async () => {
    sessionImpl = async () => lpSession({ amount_total: 330000 });
    await POST(signed(makeEvent("checkout.session.completed", lpSession({ amount_total: 1 }))));
    expect(lpStore.payments.get("cs_test_lp1")!.amountTotal).toBe(330000);
  });
  test("re-fetched Session is not an LP session → ignored", async () => {
    sessionImpl = async () => lpSession({ metadata: { source: "something-else" } });
    const body = await (await POST(signed(makeEvent("checkout.session.completed", lpSession())))).json();
    expect(body.lpSetupFee.reason).toBe("not_lp_session");
    expect(noticesSent()).toBe(0);
  });
  test("Session not found at Stripe → ignored session_not_found", async () => {
    sessionImpl = async () => {
      throw Object.assign(new Error("No such checkout.session"), { statusCode: 404, code: "resource_missing" });
    };
    const body = await (await POST(signed(makeEvent("checkout.session.completed", lpSession())))).json();
    expect(body.lpSetupFee.reason).toBe("session_not_found");
    expect(noticesSent()).toBe(0);
  });
  test("Stripe API error on re-fetch → 500 (Stripe retries), nothing recorded", async () => {
    sessionImpl = async () => {
      throw Object.assign(new Error("api down"), { statusCode: 500 });
    };
    const res = await POST(signed(makeEvent("checkout.session.completed", lpSession())));
    expect(res.status).toBe(500);
    expect(lpStore.events.size + lpStore.payments.size).toBe(0);
    expect(noticesSent()).toBe(0);
  });
  test("malformed Session id in the payload → ignored, no Stripe call", async () => {
    const body = await (await POST(signed(makeEvent("checkout.session.completed", lpSession({ id: "cs_test_../../x" }))))).json();
    expect(body.lpSetupFee.reason).toBe("invalid_session_id");
    expect(sessionRetrieves).toEqual([]);
  });
});

describe("dedupe: event id and Session id", () => {
  test("the same event replayed → notified once (event ledger)", async () => {
    const evt = makeEvent("checkout.session.completed", lpSession());
    await POST(signed(evt));
    const again = await (await POST(signed(evt))).json();
    expect(again.duplicate).toBe(true);
    expect(noticesSent()).toBe(2); // 1 Slack + 1 email, from the first delivery only
  });
  test("the same event replayed while the event ledger is unavailable → still notified once (lp_provisioning_events + notice claim)", async () => {
    ledgerOverride = null;
    const evt = makeEvent("checkout.session.completed", lpSession());
    await POST(signed(evt));
    const again = await (await POST(signed(evt))).json();
    expect(again.lpSetupFee.action).toBe("duplicate");
    expect(lpStore.events.size).toBe(1);
    expect(noticesSent()).toBe(2);
  });
  test("a second event for the same Session (completed, then async_payment_succeeded) → one payment row, notified once", async () => {
    await POST(signed(makeEvent("checkout.session.completed", lpSession())));
    const second = await (await POST(signed(makeEvent("checkout.session.async_payment_succeeded", lpSession())))).json();
    expect(second.lpSetupFee.action).toBe("duplicate");
    expect(lpStore.payments.size).toBe(1);
    expect(lpStore.events.size).toBe(2);
    expect(noticesSent()).toBe(2);
  });
  test("concurrent deliveries of two events for one Session → notified once", async () => {
    await Promise.all([
      POST(signed(makeEvent("checkout.session.completed", lpSession()))),
      POST(signed(makeEvent("checkout.session.async_payment_succeeded", lpSession()))),
    ]);
    expect(slackPosts).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });
  test("every notice channel fails → 500, claim released; the retry notifies exactly once", async () => {
    slackOk = false;
    emailOk = false;
    const evt = makeEvent("checkout.session.completed", lpSession());
    expect((await POST(signed(evt))).status).toBe(500);
    expect(lpStore.payments.get("cs_test_lp1")!.noticeResult).toBeNull();
    slackOk = true;
    emailOk = true;
    slackPosts.length = 0;
    emails.length = 0;
    const res = await POST(signed(evt));
    expect(res.status).toBe(200);
    expect(noticesSent()).toBe(2);
    expect(lpStore.payments.get("cs_test_lp1")!.noticeResult).toBe("sent");
  });
  test("no notice destination configured → recorded as no_destination, 200, not retried forever", async () => {
    delete process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK;
    delete process.env.BILLING_NOTIFY_EMAIL;
    const body = await (await POST(signed(makeEvent("checkout.session.completed", lpSession())))).json();
    expect(body.lpSetupFee.action).toBe("no_destination");
    expect(lpStore.payments.get("cs_test_lp1")!.noticeResult).toBe("no_destination");
  });
});

describe("LP_CUSTOMER_EMAIL_HASH_KEY missing → fail closed", () => {
  for (const v of [undefined, "", "replace_me"]) {
    test(`key ${v === undefined ? "unset" : JSON.stringify(v)}: 200, event recorded as ignored (email_hash_key_missing), nothing stored, no Stripe call, no notice`, async () => {
      if (v === undefined) delete process.env.LP_CUSTOMER_EMAIL_HASH_KEY;
      else process.env.LP_CUSTOMER_EMAIL_HASH_KEY = v;
      const evt = makeEvent("checkout.session.completed", lpSession());
      const res = await POST(signed(evt));
      expect(res.status).toBe(200);
      expect((await res.json()).lpSetupFee).toEqual({ action: "ignored", reason: "email_hash_key_missing", mode: "dry_run" });
      expect(lpStore.events.get(evt.id)).toMatchObject({ outcome: "ignored", reason: "email_hash_key_missing", stripeCheckoutSessionId: "cs_test_lp1" });
      expect(lpStore.payments.size).toBe(0);
      expect(sessionRetrieves).toEqual([]);
      expect(noticesSent()).toBe(0);
      expect(logs.join("\n")).toContain("LP_CUSTOMER_EMAIL_HASH_KEY");
      expect(ledger.rows.get(evt.id)?.status).toBe("processed");
    });
  }
  test("after the key is set, re-sending the same event from Stripe records and notifies once", async () => {
    delete process.env.LP_CUSTOMER_EMAIL_HASH_KEY;
    ledgerOverride = null; // Stripe dashboard "resend" re-delivers the same event id; the app ledger is bypassed here
    const evt = makeEvent("checkout.session.completed", lpSession());
    await POST(signed(evt));
    process.env.LP_CUSTOMER_EMAIL_HASH_KEY = EMAIL_KEY;
    const body = await (await POST(signed(evt))).json();
    expect(body.lpSetupFee.action).toBe("notified");
    expect(lpStore.payments.size).toBe(1);
    expect(noticesSent()).toBe(2);
  });
});

describe("no raw email anywhere", () => {
  test("payment row, event rows, notices, response body and logs never contain the address or its local part", async () => {
    const res = await POST(signed(makeEvent("checkout.session.completed", lpSession())));
    const all = [
      JSON.stringify([...lpStore.payments.values()]),
      JSON.stringify([...lpStore.events.values()]),
      ...slackPosts.map((p) => p.body),
      ...emails.map((e) => `${e.subject}${e.body}`),
      JSON.stringify(await res.json()),
      logs.join("\n"),
    ].join("\n").toLowerCase();
    expect(all).not.toContain(EMAIL.toLowerCase());
    expect(all).not.toContain("hanako.suzuki");
  });
});

describe("invalid metadata values", () => {
  test("tampered lpPage / lpRef / referral code / plan → marker in record and notice, never raw", async () => {
    sessionImpl = async () =>
      lpSession({ metadata: { source: "lp-ai-employee", plan: "proper<x>", lpPage: "javascript:alert(1)", lpRef: "<img src=x>", referralCode: "AIC-<svg>" } });
    await POST(signed(makeEvent("checkout.session.completed", lpSession())));
    const row = lpStore.payments.get("cs_test_lp1")!;
    expect(row).toMatchObject({ plan: "(invalid)", lpPage: "(invalid)", lpRef: "(invalid)", referralCode: "(invalid)" });
    const text = JSON.parse(slackPosts[0].body).text as string;
    for (const raw of ["javascript:", "<img", "<svg", "proper<x>"]) {
      expect(text).not.toContain(raw);
      expect(emails[0].body).not.toContain(raw);
    }
    expect(text).toContain("不正な値（破棄）");
  });
});

describe("flag OFF (default) → exactly today's behaviour", () => {
  for (const v of [undefined, "off", "auto", "confirm"]) {
    test(`LP_AUTO_PROVISION_MODE=${v ?? "(unset)"}: no Stripe re-fetch, no record, no notice, same response as before`, async () => {
      if (v === undefined) delete process.env.LP_AUTO_PROVISION_MODE;
      else process.env.LP_AUTO_PROVISION_MODE = v;
      const evt = makeEvent("checkout.session.completed", lpSession());
      const res = await POST(signed(evt));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, type: "checkout.session.completed", orgId: null });
      expect(sessionRetrieves).toEqual([]);
      expect(lpStore.events.size + lpStore.payments.size).toBe(0);
      expect(noticesSent()).toBe(0);
      expect(ledger.rows.get(evt.id)?.status).toBe("processed");
    });
  }
});
