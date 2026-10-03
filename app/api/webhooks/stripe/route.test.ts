/**
 * Stripe webhook fail-closed behavior:
 *  - tenant guard: metadata org must equal the org whose stored
 *    stripe_customer_id is the event's customer; mismatch → no writes,
 *    audit log, 2xx (permanent).
 *  - transient failures → 5xx (Stripe retries); invalid signature → 400.
 *  - dedupe by event.id: processed once, done only after success.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type StripeType from "stripe";
// Bun resolves "stripe" to the worker build (SubtleCrypto, async-only webhook
// verification). Next.js (runtime=nodejs) uses the node build, so load it here.
// @ts-expect-error -- direct file import of the node build (no type entry)
import StripeNodeBuild from "../../../../node_modules/stripe/esm/stripe.esm.node.js";
const Stripe = StripeNodeBuild as unknown as typeof StripeType;
import * as realStripeModule from "@/lib/stripe";
import * as realLedgerModule from "@/lib/billing/stripe-webhook-ledger";
import * as realGuardModule from "@/lib/billing/stripe-customer-org-guard";

const realStripe = { ...realStripeModule };
const realLedger = { ...realLedgerModule };
const realGuard = { ...realGuardModule };

const SECRET = "whsec_test_secret_for_unit_tests";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const stripe = new Stripe("sk_test_unit_dummy", { typescript: true });
let retrieveImpl: (id: string) => Promise<unknown> = async () => {
  throw new Error("not stubbed");
};
(stripe.subscriptions as unknown as { retrieve: unknown }).retrieve = (id: string) =>
  retrieveImpl(id);

mock.module("@/lib/stripe", () => ({ ...realStripe, getStripe: () => stripe }));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isStripeConfigured: () => true,
}));

const upserts: Array<Record<string, unknown>> = [];
let upsertImpl: (input: Record<string, unknown>) => Promise<unknown> = async () => ({});
mock.module("@/lib/data/subscriptions", () => ({
  upsertSubscription: async (input: Record<string, unknown>) => {
    const r = await upsertImpl(input);
    upserts.push(input);
    return r;
  },
}));

const emails: string[] = [];
mock.module("@/lib/email", () => ({
  sendBillingEmail: async (_to: string, subject: string) => {
    emails.push(subject);
    return { ok: true };
  },
  sendTrialEndingEmail: async () => {
    emails.push("trial_ending");
    return { ok: true };
  },
}));

let planImpl: () => Promise<unknown> = async () => ({ processed: true, skipped: "flag_off" });
const planCalls: string[] = [];
mock.module("@/lib/billing/stripe-plan-webhook", () => ({
  processSubscriptionForPlanChange: async (event: { id: string }) => {
    planCalls.push(event.id);
    return planImpl();
  },
}));

type CardOpts = { verifyTenant?: (orgId: string, customerId: string | null) => Promise<unknown> };
let cardImpl: (raw: string, sig: string | null, opts?: CardOpts) => Promise<unknown> = async () => ({
  processed: true,
  eventType: "unknown",
  action: "ignored",
  orgId: null,
});
mock.module("@/lib/external-contract-card/webhook-handler", () => ({
  processCardSetupWebhook: (raw: string, sig: string | null, opts?: CardOpts) =>
    cardImpl(raw, sig, opts),
}));

const audits: Array<Record<string, unknown>> = [];
mock.module("@/lib/data/audit", () => ({
  appendAuditEvent: async (row: Record<string, unknown>) => {
    audits.push(row);
  },
}));

let store: ReturnType<typeof realLedger.createMemoryStripeWebhookEventStore> | null =
  realLedger.createMemoryStripeWebhookEventStore();
let storeOverride: realLedgerModule.StripeWebhookEventStore | null | undefined;
mock.module("@/lib/billing/stripe-webhook-ledger", () => ({
  ...realLedger,
  createSupabaseStripeWebhookEventStore: () =>
    storeOverride !== undefined ? storeOverride : store,
}));

let customerLinks: Record<string, string[]> = {};
let lookupError: Error | null = null;
mock.module("@/lib/billing/stripe-customer-org-guard", () => ({
  ...realGuard,
  createSupabaseLinkedOrgLookup: () => async (customerId: string) => {
    if (lookupError) throw lookupError;
    return customerLinks[customerId] ?? [];
  },
}));

const { POST } = await import("./route");

let seq = 0;
function makeEvent(type: string, object: Record<string, unknown>, id?: string) {
  return {
    id: id ?? `evt_test_${++seq}`,
    object: "event",
    type,
    api_version: "2025-08-27.basil",
    created: 1790000000,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

function signedRequest(event: unknown, opts: { badSignature?: boolean } = {}) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.badSignature ? "whsec_wrong" : SECRET,
  });
  return new Request("https://staffpass.example/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

function sub(orgId: string | null, customer: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    status: "active",
    customer,
    metadata: orgId ? { orgId, org_id: orgId, planKey: "business" } : {},
    items: { data: [{ price: { id: "price_x" }, current_period_end: 1795000000 }] },
    cancel_at_period_end: false,
    trial_end: null,
    ...extra,
  };
}

beforeEach(() => {
  upserts.length = 0;
  emails.length = 0;
  planCalls.length = 0;
  audits.length = 0;
  store = realLedger.createMemoryStripeWebhookEventStore();
  storeOverride = undefined;
  customerLinks = { cus_a: [ORG_A], cus_b: [ORG_B] };
  lookupError = null;
  upsertImpl = async () => ({});
  planImpl = async () => ({ processed: true, skipped: "flag_off" });
  retrieveImpl = async () => {
    throw new Error("not stubbed");
  };
  cardImpl = async () => ({ processed: true, eventType: "unknown", action: "ignored", orgId: null });
});

describe("signature (permanent → 4xx)", () => {
  test("invalid signature → 400, nothing processed, no ledger row", async () => {
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const res = await POST(signedRequest(evt, { badSignature: true }));
    expect(res.status).toBe(400);
    expect(upserts.length).toBe(0);
    expect(store!.rows.size).toBe(0);
  });
});

describe("tenant guard (customer ↔ org)", () => {
  test("matching org/customer → synced, 200, ledger processed", async () => {
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect(upserts.length).toBe(1);
    expect(upserts[0].orgId).toBe(ORG_A);
    expect(store!.rows.get(evt.id)?.status).toBe("processed");
  });

  test("metadata org A but customer linked to org B → 2xx, no writes, audit, ledger rejected", async () => {
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_b"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rejected).toBe("customer_org_mismatch");
    expect(upserts.length).toBe(0);
    expect(planCalls.length).toBe(0);
    expect(emails.length).toBe(0);
    expect(audits.map((a) => a.orgId).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(audits.every((a) => a.purpose === "stripe_webhook.tenant_mismatch")).toBe(true);
    expect(store!.rows.get(evt.id)?.status).toBe("rejected");
  });

  test("customer not linked to any org → 2xx rejected, no writes", async () => {
    const evt = makeEvent("customer.subscription.created", sub(ORG_A, "cus_unlinked"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect((await res.json()).rejected).toBe("customer_not_linked");
    expect(upserts.length).toBe(0);
    expect(audits.length).toBe(1);
  });

  test("trial_will_end with mismatched customer → rejected, no email", async () => {
    const evt = makeEvent("customer.subscription.trial_will_end", sub(ORG_A, "cus_b"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect(upserts.length).toBe(0);
    expect(emails.length).toBe(0);
  });

  test("subscription without org metadata → 200 skip (unchanged), no writes", async () => {
    const evt = makeEvent("customer.subscription.updated", sub(null, "cus_a"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect(upserts.length).toBe(0);
  });

  test("checkout.session.completed: client_reference_id A, subscription metadata B → rejected", async () => {
    retrieveImpl = async () => sub(ORG_B, "cus_a");
    const evt = makeEvent("checkout.session.completed", {
      id: "cs_1",
      object: "checkout.session",
      mode: "subscription",
      client_reference_id: ORG_A,
      metadata: { orgId: ORG_A },
      customer: "cus_a",
      subscription: "sub_1",
    });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect((await res.json()).rejected).toBe("metadata_org_conflict");
    expect(upserts.length).toBe(0);
  });

  test("checkout.session.completed without subscription: unlinked customer can no longer be attached via webhook", async () => {
    const evt = makeEvent("checkout.session.completed", {
      id: "cs_2",
      object: "checkout.session",
      mode: "subscription",
      client_reference_id: ORG_A,
      metadata: { orgId: ORG_A },
      customer: "cus_unlinked",
      subscription: null,
    });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect((await res.json()).rejected).toBe("customer_not_linked");
    expect(upserts.length).toBe(0);
  });

  test("checkout.session.completed mode=setup (card registration) never overwrites the subscription row", async () => {
    const evt = makeEvent("checkout.session.completed", {
      id: "cs_setup",
      object: "checkout.session",
      mode: "setup",
      client_reference_id: ORG_A,
      metadata: { orgId: ORG_A, purpose: "payment_method_setup" },
      customer: "cus_a",
      subscription: null,
    });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect(upserts.length).toBe(0);
  });

  test("LP AI社員パック setup fee (mode=payment, no org, no subscription) → 200 no-op, no audit", async () => {
    const evt = makeEvent("checkout.session.completed", {
      id: "cs_lp",
      object: "checkout.session",
      mode: "payment",
      client_reference_id: null,
      metadata: { plan: "intern", source: "lp-ai-employee", setupYen: "150000" },
      customer: null,
      subscription: null,
    });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rejected).toBeUndefined();
    expect(upserts.length).toBe(0);
    expect(audits.length).toBe(0);
    expect(store!.rows.get(evt.id)?.status).toBe("processed");
  });

  test("invoice.paid: invoice customer differs from subscription customer → rejected", async () => {
    retrieveImpl = async () => sub(ORG_A, "cus_a");
    const evt = makeEvent("invoice.paid", {
      id: "in_1",
      object: "invoice",
      customer: "cus_b",
      metadata: {},
      parent: { subscription_details: { subscription: "sub_1", metadata: {} } },
    });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect((await res.json()).rejected).toBe("customer_conflict");
    expect(upserts.length).toBe(0);
  });

  test("invoice.paid matching → synced", async () => {
    retrieveImpl = async () => sub(ORG_A, "cus_a");
    const evt = makeEvent("invoice.paid", {
      id: "in_2",
      object: "invoice",
      customer: "cus_a",
      metadata: {},
      parent: { subscription_details: { subscription: "sub_1", metadata: {} } },
    });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect(upserts.length).toBe(1);
  });

  test("card setup handler gets a tenant verifier and its mismatch is rejected + audited (2xx)", async () => {
    cardImpl = async (_raw, _sig, opts) => {
      expect(typeof opts?.verifyTenant).toBe("function");
      const check = await opts!.verifyTenant!(ORG_A, "cus_b");
      return { processed: false, reason: "tenant_mismatch", tenantCheck: check };
    };
    const evt = makeEvent("setup_intent.succeeded", { id: "seti_1", object: "setup_intent" });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect((await res.json()).rejected).toBe("customer_org_mismatch");
    expect(audits.length).toBe(2);
    expect(store!.rows.get(evt.id)?.status).toBe("rejected");
  });

  test("org lookup DB error → 5xx (transient), not processed", async () => {
    lookupError = new Error("db down");
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(upserts.length).toBe(0);
    expect(store!.rows.get(evt.id)?.status).toBe("failed");
  });
});

describe("transient failures → 5xx and retry", () => {
  test("DB error during subscription upsert → 500, ledger failed; retry processes once", async () => {
    let fail = true;
    upsertImpl = async () => {
      if (fail) throw new Error("subscription_upsert_failed");
      return {};
    };
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const r1 = await POST(signedRequest(evt));
    expect(r1.status).toBe(500);
    expect(store!.rows.get(evt.id)?.status).toBe("failed");
    const text = JSON.stringify(await r1.json());
    expect(text).not.toContain("cus_a");

    fail = false;
    const r2 = await POST(signedRequest(evt));
    expect(r2.status).toBe(200);
    expect(upserts.length).toBe(1);
    expect(store!.rows.get(evt.id)?.status).toBe("processed");
  });

  test("Stripe API error retrieving subscription (invoice.paid) → 500 (no longer swallowed)", async () => {
    retrieveImpl = async () => {
      throw new Stripe.errors.StripeConnectionError({ message: "conn reset" } as never);
    };
    const evt = makeEvent("invoice.paid", {
      id: "in_3",
      object: "invoice",
      customer: "cus_a",
      metadata: {},
      parent: { subscription_details: { subscription: "sub_1", metadata: {} } },
    });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(500);
    expect(store!.rows.get(evt.id)?.status).toBe("failed");
  });

  test("Stripe 404 (subscription deleted) on retrieve → permanent, 200 without sync", async () => {
    retrieveImpl = async () => {
      throw new Stripe.errors.StripeInvalidRequestError({
        message: "No such subscription",
        code: "resource_missing",
        statusCode: 404,
      } as never);
    };
    const evt = makeEvent("invoice.payment_failed", {
      id: "in_4",
      object: "invoice",
      customer: "cus_a",
      metadata: {},
      parent: { subscription_details: { subscription: "sub_gone", metadata: {} } },
    });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect(upserts.length).toBe(0);
  });

  test("Plan Rails handler throws → 500, ledger failed", async () => {
    planImpl = async () => {
      throw new Error("ticket insert failed");
    };
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(500);
    expect(store!.rows.get(evt.id)?.status).toBe("failed");
  });

  test("card setup persist failure (complete_failed) → 500", async () => {
    cardImpl = async () => ({ processed: false, reason: "complete_failed", error: "db" });
    const evt = makeEvent("setup_intent.succeeded", { id: "seti_2", object: "setup_intent" });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(500);
    expect(store!.rows.get(evt.id)?.status).toBe("failed");
  });

  test("card setup handler throws → 500", async () => {
    cardImpl = async () => {
      throw new Error("audit insert failed");
    };
    const evt = makeEvent("setup_intent.canceled", { id: "seti_3", object: "setup_intent" });
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(500);
  });

  test("ledger claim DB error (not a missing table) → 503 before any processing", async () => {
    storeOverride = {
      ...realLedger.createMemoryStripeWebhookEventStore(),
      insertProcessing: async () => {
        throw new Error("connection reset");
      },
    };
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(503);
    expect(upserts.length).toBe(0);
  });
});

describe("dedupe by event.id", () => {
  test("same event delivered twice → processed once, second is 2xx duplicate", async () => {
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const r1 = await POST(signedRequest(evt));
    const r2 = await POST(signedRequest(evt));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await r2.json()).duplicate).toBe(true);
    expect(upserts.length).toBe(1);
    expect(planCalls.length).toBe(1);
    expect(emails.length).toBe(1);
  });

  test("duplicate while first delivery still processing → 409 (Stripe retries later)", async () => {
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    await realLedger.claimStripeWebhookEvent(store, evt);
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(409);
    expect(upserts.length).toBe(0);
  });

  test("ledger table missing (migration not applied) → fail-safe: processed without dedupe", async () => {
    storeOverride = {
      ...realLedger.createMemoryStripeWebhookEventStore(),
      insertProcessing: async () => {
        throw new realLedger.WebhookLedgerUnavailableError("relation does not exist");
      },
    };
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(200);
    expect(upserts.length).toBe(1);
  });

  test("ledger missing + transient failure → still 5xx", async () => {
    storeOverride = null;
    upsertImpl = async () => {
      throw new Error("db down");
    };
    const evt = makeEvent("customer.subscription.updated", sub(ORG_A, "cus_a"));
    const res = await POST(signedRequest(evt));
    expect(res.status).toBe(500);
  });
});
