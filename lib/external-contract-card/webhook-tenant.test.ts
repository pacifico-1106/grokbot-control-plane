/**
 * Card setup webhook: when the route supplies a tenant verifier, a
 * customer ↔ org mismatch must stop before any payment-method write.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type StripeType from "stripe";
// @ts-expect-error -- node build (bun resolves "stripe" to the worker build)
import StripeNodeBuild from "../../node_modules/stripe/esm/stripe.esm.node.js";
import * as realStripeModule from "@/lib/stripe";

const Stripe = StripeNodeBuild as unknown as typeof StripeType;
const realStripe = { ...realStripeModule };
const SECRET = "whsec_card_setup_unit";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
const stripe = new Stripe("sk_test_unit_dummy");

const ORG_A = "11111111-1111-4111-8111-111111111111";
const writes: string[] = [];

mock.module("@/lib/stripe", () => ({ ...realStripe, getStripe: () => stripe }));
mock.module("./feature-flag", () => ({ isExternalContractCardSetupEnabled: () => true }));
mock.module("./data", () => ({
  completePaymentMethodSetup: async () => {
    writes.push("complete");
  },
  failPaymentMethodSetup: async () => {
    writes.push("fail");
  },
  recordCardAuditEvent: async () => {
    writes.push("audit");
  },
  getPaymentMethodBySetupIntent: async () => null,
  isSetupIntentProcessed: async () => false,
}));

const { processCardSetupWebhook } = await import("./webhook-handler");

function signed(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: "evt_card_1",
    object: "event",
    type,
    data: { object },
  });
  return {
    payload,
    header: stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }),
  };
}

const mismatch = async () => ({
  ok: false as const,
  reason: "customer_org_mismatch" as const,
  claimedOrgIds: [ORG_A],
  customerIds: ["cus_b"],
  linkedOrgIds: ["22222222-2222-4222-8222-222222222222"],
});
const match = async (orgId: string, customerId: string | null) => ({
  ok: true as const,
  orgId,
  customerId: customerId || "",
});

beforeEach(() => {
  writes.length = 0;
});

const meta = { purpose: "payment_method_setup", orgId: ORG_A, approvalId: "apr_1" };

describe("card setup webhook tenant verifier", () => {
  test("setup_intent.succeeded with mismatch → tenant_mismatch, no writes", async () => {
    const { payload, header } = signed("setup_intent.succeeded", {
      id: "seti_1",
      object: "setup_intent",
      customer: "cus_b",
      payment_method: "pm_1",
      metadata: meta,
    });
    const seen: Array<[string, string | null]> = [];
    const r = await processCardSetupWebhook(payload, header, {
      verifyTenant: async (o, c) => {
        seen.push([o, c]);
        return mismatch();
      },
    });
    expect(r.processed).toBe(false);
    if (!r.processed) {
      expect(r.reason).toBe("tenant_mismatch");
      expect(r.tenantCheck?.reason).toBe("customer_org_mismatch");
    }
    expect(seen).toEqual([[ORG_A, "cus_b"]]);
    expect(writes).toEqual([]);
  });

  test("setup_intent.succeeded with match → persisted", async () => {
    const { payload, header } = signed("setup_intent.succeeded", {
      id: "seti_2",
      object: "setup_intent",
      customer: "cus_a",
      payment_method: "pm_2",
      metadata: meta,
    });
    const r = await processCardSetupWebhook(payload, header, { verifyTenant: match });
    expect(r.processed).toBe(true);
    expect(writes).toContain("complete");
  });

  test("setup_intent.canceled with mismatch → no writes", async () => {
    const { payload, header } = signed("setup_intent.canceled", {
      id: "seti_3",
      object: "setup_intent",
      customer: "cus_b",
      metadata: meta,
    });
    const r = await processCardSetupWebhook(payload, header, { verifyTenant: mismatch });
    expect(r.processed).toBe(false);
    expect(writes).toEqual([]);
  });

  test("checkout.session.expired (setup) with mismatch → no writes", async () => {
    const { payload, header } = signed("checkout.session.expired", {
      id: "cs_1",
      object: "checkout.session",
      mode: "setup",
      customer: "cus_b",
      setup_intent: "seti_4",
      metadata: meta,
    });
    const r = await processCardSetupWebhook(payload, header, { verifyTenant: mismatch });
    expect(r.processed).toBe(false);
    expect(writes).toEqual([]);
  });

  test("non card-setup events never call the verifier", async () => {
    const { payload, header } = signed("setup_intent.succeeded", {
      id: "seti_5",
      object: "setup_intent",
      customer: "cus_b",
      metadata: { purpose: "something_else" },
    });
    let called = 0;
    const r = await processCardSetupWebhook(payload, header, {
      verifyTenant: async () => {
        called++;
        return mismatch();
      },
    });
    expect(r.processed).toBe(true);
    expect(called).toBe(0);
  });
});
