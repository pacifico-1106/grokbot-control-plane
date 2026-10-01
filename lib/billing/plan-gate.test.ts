/**
 * Tests for P1 Plan Rails — plan-gate.ts
 *
 * These tests verify plan gating behavior with flag OFF (DEMO mode).
 * When flag is OFF, all tools should be allowed.
 */

import { describe, expect, test } from "bun:test";
import {
  assertGatewayToolAllowedForPlan,
  assertAdminToolAllowedForPlan,
} from "./plan-gate";

describe("plan-gate (flag OFF / DEMO mode)", () => {
  describe("assertGatewayToolAllowedForPlan", () => {
    test("should allow all tools when flag is OFF", async () => {
      const result = await assertGatewayToolAllowedForPlan("org_123", "commerce.order");
      expect(result.ok).toBe(true);
    });

    test("should return null planKey when flag is OFF", async () => {
      const result = await assertGatewayToolAllowedForPlan("org_123", "mail.send");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.planKey).toBe(null);
      }
    });
  });

  describe("assertAdminToolAllowedForPlan", () => {
    test("should allow all tools when flag is OFF", async () => {
      const result = await assertAdminToolAllowedForPlan("org_123", "ingressHandoff.patch");
      expect(result.ok).toBe(true);
    });

    test("should return null planKey when flag is OFF", async () => {
      const result = await assertAdminToolAllowedForPlan("org_123", "policy.patch");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.planKey).toBe(null);
      }
    });
  });
});
