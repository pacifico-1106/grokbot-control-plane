import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCatalogModule from "@/lib/lp/catalog";

/**
 * AI社員パック checkout (mode=payment) is the only purchase path left. The
 * Stripe Price it charges must be on the server-side purchasable allowlist:
 * a catalog row (LP_CATALOG_DB_ENABLED) that points at a retired plan price
 * (STRIPE_PRICE_ID_BUSINESS / _MANAGED) or any other env key is refused
 * before the order ledger or Stripe is touched. Price ids in the body are
 * ignored.
 */
const realCatalog = { ...realCatalogModule };
const APP = "https://staffpass.example";
const created: Array<Record<string, unknown>> = [];
mock.module("@/lib/stripe", () => ({
  getAppUrl: () => APP,
  getCheckoutPaymentMethodTypes: () => ["card"],
  getStripe: () => ({
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          created.push(args);
          return { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" };
        },
      },
    },
  }),
}));

let envKeyOverride: string | null | undefined;
mock.module("@/lib/lp/catalog", () => ({
  ...realCatalog,
  getCatalogItem: async (sku: string) => {
    const item = realCatalog.HARDCODED_CATALOG.items.find((i) => i.sku === sku) ?? null;
    if (!item || envKeyOverride === undefined) return item;
    return { ...item, stripePriceEnvKey: envKeyOverride };
  },
}));

const orders: unknown[] = [];
mock.module("@/lib/lp/order-ledger", () => ({
  createOrder: async (o: unknown) => {
    orders.push(o);
    return { id: "ord_1", currentRevision: 1 };
  },
  createCheckoutAttempt: async () => ({ id: "att_1" }),
  updateCheckoutAttemptStatus: async () => undefined,
}));

const ENV = [
  "STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN",
  "STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER",
  "STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE",
  "STRIPE_PRICE_ID_BUSINESS",
  "STRIPE_PRICE_ID_MANAGED",
  "STRIPE_PRICE_ID_STARTER",
  "STRIPE_PRICE_ID_KICKOFF_PACK",
  "LP_ORDER_LEDGER_ENABLED",
  "LP_CATALOG_DB_ENABLED",
];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  created.length = 0;
  orders.length = 0;
  envKeyOverride = undefined;
  process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN = "price_intern";
  process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER = "price_proper";
  process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE = "price_exec";
  process.env.STRIPE_PRICE_ID_BUSINESS = "price_business";
  process.env.STRIPE_PRICE_ID_MANAGED = "price_managed";
  process.env.STRIPE_PRICE_ID_STARTER = "price_starter";
  process.env.STRIPE_PRICE_ID_KICKOFF_PACK = "price_kickoff";
  process.env.LP_ORDER_LEDGER_ENABLED = "1";
  delete process.env.LP_CATALOG_DB_ENABLED;
});

const route = await import("./route");
const post = (body: Record<string, unknown>) =>
  route.POST(
    new Request(`${APP}/api/lp/ai-employee/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP },
      body: JSON.stringify(body),
    })
  );
const get = (plan: string) => route.GET(new Request(`${APP}/api/lp/ai-employee/checkout?plan=${plan}`));

describe("AI社員パック checkout still works", () => {
  for (const [plan, price] of [
    ["intern", "price_intern"],
    ["proper", "price_proper"],
    ["executive", "price_exec"],
  ]) {
    test(`${plan} → 200, Checkout Session with ${price}, mode=payment`, async () => {
      const res = await post({ plan, email: "lead@customer.test" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain("checkout.stripe.com");
      expect(created).toHaveLength(1);
      expect(created[0].mode).toBe("payment");
      expect(created[0].line_items).toEqual([{ price, quantity: 1 }]);
    });
  }

  test("price / priceId / line_items in the body are ignored (server picks the price)", async () => {
    await post({
      plan: "intern",
      price: "price_business",
      priceId: "price_managed",
      line_items: [{ price: "price_business", quantity: 1 }],
      stripePriceEnvKey: "STRIPE_PRICE_ID_BUSINESS",
    });
    expect(created).toHaveLength(1);
    expect(created[0].line_items).toEqual([{ price: "price_intern", quantity: 1 }]);
  });
});

describe("catalog row pointing at a non-allowlisted price is refused", () => {
  for (const key of ["STRIPE_PRICE_ID_BUSINESS", "STRIPE_PRICE_ID_MANAGED", "STRIPE_PRICE_ID_STARTER"]) {
    test(`${key} → 410 plan_retired, no order, no Stripe session`, async () => {
      envKeyOverride = key;
      const res = await post({ plan: "intern", email: "lead@customer.test" });
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.error).toBe("plan_retired");
      expect(body.message).toContain("新規のお申し込みは終了");
      expect(JSON.stringify(body)).not.toContain("price_");
      expect(created).toHaveLength(0);
      expect(orders).toHaveLength(0);
    });
  }

  for (const key of ["STRIPE_PRICE_ID_KICKOFF_PACK", "STRIPE_SECRET_KEY_LOOKALIKE"]) {
    test(`unknown price env ${key} → 404 price_not_purchasable, no order, no Stripe session`, async () => {
      process.env.STRIPE_SECRET_KEY_LOOKALIKE = "price_lookalike";
      envKeyOverride = key;
      const res = await post({ plan: "intern", email: "lead@customer.test" });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("price_not_purchasable");
      expect(created).toHaveLength(0);
      expect(orders).toHaveLength(0);
      delete process.env.STRIPE_SECRET_KEY_LOOKALIKE;
    });
  }

  test("GET reports checkoutAvailable=false for a retired price", async () => {
    envKeyOverride = "STRIPE_PRICE_ID_BUSINESS";
    const body = await (await get("intern")).json();
    expect(body.checkoutAvailable).toBe(false);
    envKeyOverride = undefined;
    expect((await (await get("intern")).json()).checkoutAvailable).toBe(true);
  });
});
