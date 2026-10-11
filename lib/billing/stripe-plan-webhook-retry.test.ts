/**
 * Plan Rails webhook: an exception while handling must NOT mark the event as
 * processed (otherwise Stripe's retry is swallowed). The error propagates so
 * the webhook returns 5xx and Stripe retries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const marked: string[] = [];
let processedLookup: () => Promise<boolean> = async () => false;
let planInfo: () => Promise<unknown> = async () => ({ planKey: "intern", billingStatus: "active" });

mock.module("@/lib/feature-flags", () => ({ isPlanRailsEnabled: () => true }));
mock.module("./stripe-events", () => ({
  isStripeEventProcessed: () => processedLookup(),
  markStripeEventProcessed: async (id: string) => {
    marked.push(id);
  },
}));
mock.module("./org-plan", () => ({ getOrgPlanInfo: () => planInfo() }));
mock.module("./plan-change-handler", () => ({
  handlePlanDowngrade: async () => ({ ok: true }),
  handleBillingStatusChange: async () => ({ ok: true }),
}));
let upgrade: () => Promise<unknown> = async () => ({ ok: true });
mock.module("./plan-upgrade-handler", () => ({ createUpgradeTicket: () => upgrade() }));

const { processSubscriptionForPlanChange } = await import("./stripe-plan-webhook");

function evt(id: string) {
  return {
    id,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        status: "active",
        metadata: { plan_key: "proper" },
        items: { data: [] },
      },
    },
  } as never;
}

beforeEach(() => {
  marked.length = 0;
  processedLookup = async () => false;
  planInfo = async () => ({ planKey: "intern", billingStatus: "active" });
  upgrade = async () => ({ ok: true });
});

describe("processSubscriptionForPlanChange retry semantics", () => {
  test("success → marked processed", async () => {
    const r = await processSubscriptionForPlanChange(evt("evt_ok"), "org-1");
    expect(r.action).toBe("upgrade_ticket");
    expect(marked).toEqual(["evt_ok"]);
  });

  test("handler throws → rethrown, NOT marked processed", async () => {
    upgrade = async () => {
      throw new Error("db down");
    };
    await expect(processSubscriptionForPlanChange(evt("evt_err"), "org-1")).rejects.toThrow(
      "db down"
    );
    expect(marked).toEqual([]);
  });

  test("org plan lookup throws → rethrown, NOT marked processed", async () => {
    planInfo = async () => {
      throw new Error("timeout");
    };
    await expect(processSubscriptionForPlanChange(evt("evt_err2"), "org-1")).rejects.toThrow(
      "timeout"
    );
    expect(marked).toEqual([]);
  });

  test("dedup lookup throws → rethrown (never treated as 'not processed')", async () => {
    processedLookup = async () => {
      throw new Error("lookup failed");
    };
    await expect(processSubscriptionForPlanChange(evt("evt_err3"), "org-1")).rejects.toThrow(
      "lookup failed"
    );
    expect(marked).toEqual([]);
  });
});
