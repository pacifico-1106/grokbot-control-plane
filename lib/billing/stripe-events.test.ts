/**
 * Tests for P1 Plan Rails — stripe-events.ts
 *
 * These tests run with DEMO mode (no Supabase configured in test environment).
 */

import { describe, expect, test } from "bun:test";
import {
  isStripeEventProcessed,
  markStripeEventProcessed,
  getProcessedEvent,
  listProcessedEventsForOrg,
} from "./stripe-events";

describe("stripe-events (DEMO mode)", () => {
  describe("isStripeEventProcessed", () => {
    test("should return false when supabase not configured", async () => {
      const result = await isStripeEventProcessed("evt_test_123");
      expect(result).toBe(false);
    });
  });

  describe("markStripeEventProcessed", () => {
    test("should not throw when supabase not configured", async () => {
      await markStripeEventProcessed(
        "evt_test_123",
        "customer.subscription.updated",
        "org_123"
      );
    });
  });

  describe("getProcessedEvent", () => {
    test("should return null when supabase not configured", async () => {
      const result = await getProcessedEvent("evt_test_123");
      expect(result).toBe(null);
    });
  });

  describe("listProcessedEventsForOrg", () => {
    test("should return empty array when supabase not configured", async () => {
      const result = await listProcessedEventsForOrg("org_123");
      expect(result).toEqual([]);
    });
  });
});
