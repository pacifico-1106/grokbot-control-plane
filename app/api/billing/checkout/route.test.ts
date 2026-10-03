/**
 * Legacy SaaS checkout (/api/billing/checkout) must never create a Stripe
 * Customer / Checkout Session / Subscription (with trial) without human
 * approval. There is no approved-contract record type today, so the route is
 * closed in every mode (fail-closed).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const calls = {
  customersCreate: 0,
  sessionsCreate: 0,
  setCustomer: 0,
  referral: 0,
};

let session: Record<string, unknown> = {};

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
}));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isStripeConfigured: () => true,
}));
mock.module("@/lib/data/org-context", () => ({
  setOrgReferralCodeIfEmpty: async () => {
    calls.referral++;
    return null;
  },
}));
mock.module("@/lib/data/subscriptions", () => ({
  getOrgStripeCustomerId: async () => null,
  setOrgStripeCustomerId: async () => {
    calls.setCustomer++;
  },
}));

const fakeStripe = {
  customers: {
    create: async () => {
      calls.customersCreate++;
      return { id: "cus_new" };
    },
  },
  checkout: {
    sessions: {
      create: async () => {
        calls.sessionsCreate++;
        return { id: "cs_1", url: "https://checkout.stripe.test/cs_1" };
      },
    },
  },
};
let stripeConfigured = true;
mock.module("@/lib/stripe", () => ({
  getStripe: () => (stripeConfigured ? fakeStripe : null),
  getPriceId: () => "price_business_live",
  getBusinessOnboardingPriceId: () => "price_onboarding",
  getCheckoutPaymentMethodTypes: () => ["card"],
  getAppUrl: () => "https://staffpass.example",
  TRIAL_DAYS: 14,
}));

const routeModule = await import("./route");
// The handler intentionally ignores the request (no client-supplied org/plan
// input is read); call it with a request anyway to prove that.
const POST = routeModule.POST as unknown as (req: Request) => Promise<Response>;

function req(body: unknown) {
  return new Request("https://staffpass.example/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  calls.customersCreate = 0;
  calls.sessionsCreate = 0;
  calls.setCustomer = 0;
  calls.referral = 0;
  stripeConfigured = true;
  session = {
    demo: false,
    userId: "user-1",
    email: "owner@customer.test",
    orgId: "11111111-1111-4111-8111-111111111111",
    member: { role: "owner" },
  };
});

describe("POST /api/billing/checkout (legacy SaaS) is closed", () => {
  for (const planKey of ["starter", "business", "managed"]) {
    test(`owner + Stripe configured + price set (${planKey}) → 403, no Stripe or DB writes`, async () => {
      const res = await POST(req({ planKey, referral_code: "AIC-TEST" }));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("contract_requires_approval");
      expect(typeof body.message).toBe("string");
      expect(calls.customersCreate).toBe(0);
      expect(calls.sessionsCreate).toBe(0);
      expect(calls.setCustomer).toBe(0);
      expect(calls.referral).toBe(0);
    });
  }

  test("response never contains a checkout url or trial preview", async () => {
    const res = await POST(req({ planKey: "business" }));
    const text = await res.text();
    expect(text).not.toContain("checkout.stripe");
    expect(text).not.toContain("trial_period_days");
    expect(text).not.toContain("url");
  });

  test("Stripe not configured (stub mode) → also 403, no referral write", async () => {
    stripeConfigured = false;
    const res = await POST(req({ planKey: "business", referral_code: "AIC-1" }));
    expect(res.status).toBe(403);
    expect(calls.referral).toBe(0);
  });

  test("unauthenticated → 403 as well (no Stripe calls)", async () => {
    session = { demo: false, userId: null, email: null, orgId: null, member: null };
    const res = await POST(req({ planKey: "business" }));
    expect(res.status).toBe(403);
    expect(calls.sessionsCreate).toBe(0);
  });
});
