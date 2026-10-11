/**
 * stripe_processed_events: DB errors must not be reported as "not processed"
 * (that would re-run a non-idempotent upgrade ticket) nor silently dropped on
 * mark (that would lose the dedupe record). Both throw → webhook 5xx → retry.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
const failing = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }),
      }),
    }),
    upsert: async () => ({ error: { message: "connection reset" } }),
  }),
};
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => failing }));

const { isStripeEventProcessed, markStripeEventProcessed } = await import("./stripe-events");

describe("stripe-events DB errors (production)", () => {
  test("isStripeEventProcessed throws on DB error", async () => {
    await expect(isStripeEventProcessed("evt_1")).rejects.toThrow("connection reset");
  });
  test("markStripeEventProcessed throws on DB error", async () => {
    await expect(
      markStripeEventProcessed("evt_1", "customer.subscription.updated", "org-1")
    ).rejects.toThrow("connection reset");
  });
});
