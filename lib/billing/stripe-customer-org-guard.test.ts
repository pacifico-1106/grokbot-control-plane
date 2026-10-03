/**
 * Stripe webhook tenant guard: the org claimed in event metadata must be the
 * org whose stored orgs.stripe_customer_id equals the event's Customer ID.
 */
import { describe, expect, test } from "bun:test";
import {
  customerIdOf,
  recordStripeTenantMismatch,
  verifyStripeCustomerOrg,
  type LinkedOrgLookup,
} from "./stripe-customer-org-guard";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function lookupFrom(map: Record<string, string[]>): LinkedOrgLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (customerId: string) => {
    calls.push(customerId);
    return map[customerId] ?? [];
  }) as LinkedOrgLookup & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("verifyStripeCustomerOrg", () => {
  test("ok when metadata org equals the single org linked to the customer", async () => {
    const lookup = lookupFrom({ cus_a: [ORG_A] });
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [ORG_A, ORG_A], customerIds: ["cus_a"] },
      lookup
    );
    expect(r).toEqual({ ok: true, orgId: ORG_A, customerId: "cus_a" });
    expect(lookup.calls).toEqual(["cus_a"]);
  });

  test("rejects when customer is linked to a different org (cross-tenant)", async () => {
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [ORG_A], customerIds: ["cus_b"] },
      lookupFrom({ cus_b: [ORG_B] })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("customer_org_mismatch");
      expect(r.linkedOrgIds).toEqual([ORG_B]);
    }
  });

  test("rejects when customer is not linked to any org (missing link)", async () => {
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [ORG_A], customerIds: ["cus_new"] },
      lookupFrom({})
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("customer_not_linked");
  });

  test("rejects when the event carries no customer", async () => {
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [ORG_A], customerIds: [null, undefined, ""] },
      lookupFrom({})
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("customer_missing");
  });

  test("rejects when metadata claims two different orgs", async () => {
    const lookup = lookupFrom({ cus_a: [ORG_A] });
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [ORG_A, ORG_B], customerIds: ["cus_a"] },
      lookup
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata_org_conflict");
    expect(lookup.calls).toEqual([]);
  });

  test("rejects when the event references two different customers", async () => {
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [ORG_A], customerIds: ["cus_a", "cus_b"] },
      lookupFrom({ cus_a: [ORG_A], cus_b: [ORG_A] })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("customer_conflict");
  });

  test("rejects when the customer id is stored on more than one org", async () => {
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [ORG_A], customerIds: ["cus_dup"] },
      lookupFrom({ cus_dup: [ORG_A, ORG_B] })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("customer_linked_to_multiple_orgs");
  });

  test("rejects when no org is claimed (caller must not write)", async () => {
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [null, ""], customerIds: ["cus_a"] },
      lookupFrom({ cus_a: [ORG_A] })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata_org_missing");
  });

  test("lookup errors propagate (transient → caller returns 5xx)", async () => {
    const failing: LinkedOrgLookup = async () => {
      throw new Error("db down");
    };
    await expect(
      verifyStripeCustomerOrg({ claimedOrgIds: [ORG_A], customerIds: ["cus_a"] }, failing)
    ).rejects.toThrow("db down");
  });

  test("lookup unavailable (DEMO, no tenant DB) → ok with claimed org", async () => {
    const demo: LinkedOrgLookup = async () => null;
    const r = await verifyStripeCustomerOrg(
      { claimedOrgIds: [ORG_A], customerIds: ["cus_a"] },
      demo
    );
    expect(r).toEqual({ ok: true, orgId: ORG_A, customerId: "cus_a" });
  });
});

describe("customerIdOf", () => {
  test("handles string, expanded object, null", () => {
    expect(customerIdOf("cus_1")).toBe("cus_1");
    expect(customerIdOf({ id: "cus_2" })).toBe("cus_2");
    expect(customerIdOf(null)).toBe(null);
    expect(customerIdOf(undefined)).toBe(null);
    expect(customerIdOf("  ")).toBe(null);
  });
});

describe("recordStripeTenantMismatch", () => {
  test("writes one audit row per affected org without leaking the other tenant's ids", async () => {
    const rows: Array<Record<string, unknown>> = [];
    await recordStripeTenantMismatch(
      { id: "evt_1", type: "customer.subscription.updated" },
      {
        ok: false,
        reason: "customer_org_mismatch",
        claimedOrgIds: [ORG_A],
        customerIds: ["cus_b"],
        linkedOrgIds: [ORG_B],
      },
      async (row) => {
        rows.push(row as unknown as Record<string, unknown>);
      }
    );
    expect(rows.length).toBe(2);
    const forA = rows.find((r) => r.orgId === ORG_A)!;
    const forB = rows.find((r) => r.orgId === ORG_B)!;
    expect(forA.action).toBe("billing.updated");
    expect(forA.purpose).toBe("stripe_webhook.tenant_mismatch");
    const metaA = forA.metadata as Record<string, unknown>;
    expect(metaA.eventId).toBe("evt_1");
    expect(metaA.reason).toBe("customer_org_mismatch");
    // Org A must not learn org B's id or org B's Stripe customer.
    expect(JSON.stringify(forA)).not.toContain(ORG_B);
    expect(JSON.stringify(forA)).not.toContain("cus_b");
    // Org B sees its own customer id, not org A's id.
    expect(JSON.stringify(forB)).toContain("cus_b");
    expect(JSON.stringify(forB)).not.toContain(ORG_A);
  });

  test("audit write failure does not throw", async () => {
    await recordStripeTenantMismatch(
      { id: "evt_2", type: "invoice.paid" },
      {
        ok: false,
        reason: "customer_not_linked",
        claimedOrgIds: [ORG_A],
        customerIds: ["cus_x"],
        linkedOrgIds: [],
      },
      async () => {
        throw new Error("audit down");
      }
    );
  });
});
