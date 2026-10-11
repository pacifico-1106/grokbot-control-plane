/**
 * Legacy SaaS checkout (/api/billing/checkout) must never create a Stripe
 * Customer / Checkout Session / Subscription (with trial) without human
 * approval. There is no approved-contract record type today, so the route is
 * closed in every mode (fail-closed). Since 10/4 the plans it sold (BUSINESS /
 * MANAGED / STARTER) are retired: those answer 410 plan_retired, anything else 404.
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

function expectNoWrites() {
  expect(calls.customersCreate).toBe(0);
  expect(calls.sessionsCreate).toBe(0);
  expect(calls.setCustomer).toBe(0);
  expect(calls.referral).toBe(0);
}

describe("POST /api/billing/checkout (legacy SaaS) is closed", () => {
  // Retired 10/4 (AI社員パック consolidation): BUSINESS (Lite) / MANAGED (Standard),
  // and STARTER (木村 on #343: retired too, 410 rather than 404).
  for (const planKey of ["business", "managed", "starter"]) {
    test(`retired plan ${planKey} → 410 plan_retired (Japanese), no Stripe or DB writes`, async () => {
      const res = await POST(req({ planKey, referral_code: "AIC-TEST" }));
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("plan_retired");
      expect(body.message).toContain("新規のお申し込みは終了");
      expect(body.message).toContain("AI社員パック");
      expect(body.purchaseUrl).toBe("/lp/ai-employee#pricing");
      expectNoWrites();
    });
  }

  // Allowlist, not denylist: this route has NO purchasable plan, so anything
  // else (starter, unknown keys, raw Stripe price ids, junk) is 404.
  for (const body of [
    { planKey: "STARTER" },
    { planKey: "enterprise" },
    { planKey: "intern" },
    { planKey: "price_business_live" },
    { priceId: "price_business_live" },
    { price: "price_ai_emp_intern" },
    { planKey: ["business"] },
    { planKey: "BUSINESS" },
    {},
  ]) {
    test(`not purchasable ${JSON.stringify(body)} → 404 price_not_purchasable, no writes`, async () => {
      const res = await POST(req(body));
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toBe("price_not_purchasable");
      expect(json.message).toMatch(/[ぁ-んァ-ン]/);
      expectNoWrites();
    });
  }

  test("invalid JSON → 404, no writes", async () => {
    const res = await POST(
      new Request("https://staffpass.example/api/billing/checkout", { method: "POST", body: "{nope" })
    );
    expect(res.status).toBe(404);
    expectNoWrites();
  });

  test("response is utf-8 JSON and never contains a checkout url or trial preview", async () => {
    const res = await POST(req({ planKey: "business" }));
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const text = await res.text();
    expect(text).not.toContain("checkout.stripe");
    expect(text).not.toContain("trial_period_days");
    expect(text).not.toContain("price_business_live");
  });

  test("Stripe not configured (stub mode) → still refused, no referral write", async () => {
    stripeConfigured = false;
    const res = await POST(req({ planKey: "business", referral_code: "AIC-1" }));
    expect(res.status).toBe(410);
    expectNoWrites();
  });

  test("unauthenticated → refused as well (no Stripe calls)", async () => {
    session = { demo: false, userId: null, email: null, orgId: null, member: null };
    const res = await POST(req({ planKey: "managed" }));
    expect(res.status).toBe(410);
    expectNoWrites();
  });
});
