/**
 * Tests for P1 Plan Rails — plan-scopes.ts
 */

import { describe, expect, test } from "bun:test";
import type { PlanKey } from "./plan-scopes";
import {
  PLAN_KEYS,
  PLAN_TIER_ORDER,
  PLAN_GATEWAY_SCOPES,
  PLAN_ADMIN_SCOPES,
  READ_ONLY_ADMIN_TOOLS,
  STRIPE_PRICE_LOOKUP_KEYS,
  STRIPE_PRODUCT_IDS,
  isValidPlanKey,
  comparePlans,
  isPlanUpgrade,
  isPlanDowngrade,
  isGatewayToolAvailableForPlan,
  isAdminToolAvailableForPlan,
  getRevokedGatewayTools,
  getRevokedAdminTools,
  getAddedGatewayTools,
  resolvePlanKeyFromLookupKey,
  resolvePlanKeyFromProductId,
} from "./plan-scopes";

describe("plan-scopes", () => {
  describe("PLAN_KEYS", () => {
    test("should have exactly 3 plan keys in upgrade order", () => {
      expect(PLAN_KEYS).toEqual(["intern", "proper", "executive"]);
    });

    test("should have tier order matching array index", () => {
      PLAN_KEYS.forEach((key, index) => {
        expect(PLAN_TIER_ORDER[key]).toBe(index);
      });
    });
  });

  describe("isValidPlanKey", () => {
    test("should return true for valid plan keys", () => {
      expect(isValidPlanKey("intern")).toBe(true);
      expect(isValidPlanKey("proper")).toBe(true);
      expect(isValidPlanKey("executive")).toBe(true);
    });

    test("should return false for invalid plan keys", () => {
      expect(isValidPlanKey(null)).toBe(false);
      expect(isValidPlanKey(undefined)).toBe(false);
      expect(isValidPlanKey("")).toBe(false);
      expect(isValidPlanKey("custom")).toBe(false);
      expect(isValidPlanKey("starter")).toBe(false);
      expect(isValidPlanKey("business")).toBe(false);
    });
  });

  describe("comparePlans", () => {
    test("should return 0 for same plans", () => {
      expect(comparePlans("intern", "intern")).toBe(0);
      expect(comparePlans("proper", "proper")).toBe(0);
      expect(comparePlans("executive", "executive")).toBe(0);
    });

    test("should return negative for upgrades", () => {
      expect(comparePlans("intern", "proper")).toBeLessThan(0);
      expect(comparePlans("intern", "executive")).toBeLessThan(0);
      expect(comparePlans("proper", "executive")).toBeLessThan(0);
    });

    test("should return positive for downgrades", () => {
      expect(comparePlans("proper", "intern")).toBeGreaterThan(0);
      expect(comparePlans("executive", "intern")).toBeGreaterThan(0);
      expect(comparePlans("executive", "proper")).toBeGreaterThan(0);
    });

    test("should treat NULL as highest tier (legacy = all access)", () => {
      expect(comparePlans(null, "executive")).toBeGreaterThan(0);
      expect(comparePlans("executive", null)).toBeLessThan(0);
    });
  });

  describe("isPlanUpgrade / isPlanDowngrade", () => {
    test("should correctly detect upgrades", () => {
      expect(isPlanUpgrade("intern", "proper")).toBe(true);
      expect(isPlanUpgrade("intern", "executive")).toBe(true);
      expect(isPlanUpgrade("proper", "executive")).toBe(true);
      expect(isPlanUpgrade("intern", "intern")).toBe(false);
      expect(isPlanUpgrade("proper", "intern")).toBe(false);
    });

    test("should correctly detect downgrades", () => {
      expect(isPlanDowngrade("proper", "intern")).toBe(true);
      expect(isPlanDowngrade("executive", "intern")).toBe(true);
      expect(isPlanDowngrade("executive", "proper")).toBe(true);
      expect(isPlanDowngrade("intern", "intern")).toBe(false);
      expect(isPlanDowngrade("intern", "proper")).toBe(false);
    });

    test("should treat NULL → plan as downgrade (narrowing)", () => {
      expect(isPlanDowngrade(null, "executive")).toBe(true);
      expect(isPlanDowngrade(null, "intern")).toBe(true);
    });

    test("should treat plan → NULL as upgrade (widening)", () => {
      expect(isPlanUpgrade("intern", null)).toBe(true);
      expect(isPlanUpgrade("executive", null)).toBe(true);
    });
  });

  describe("PLAN_GATEWAY_SCOPES", () => {
    test("should have intern as subset of proper", () => {
      const internSet = new Set(PLAN_GATEWAY_SCOPES.intern);
      PLAN_GATEWAY_SCOPES.intern.forEach((tool) => {
        expect(PLAN_GATEWAY_SCOPES.proper).toContain(tool);
      });
      expect(PLAN_GATEWAY_SCOPES.proper.length).toBeGreaterThan(internSet.size);
    });

    test("should have proper as subset of executive", () => {
      const properSet = new Set(PLAN_GATEWAY_SCOPES.proper);
      PLAN_GATEWAY_SCOPES.proper.forEach((tool) => {
        expect(PLAN_GATEWAY_SCOPES.executive).toContain(tool);
      });
      expect(PLAN_GATEWAY_SCOPES.executive.length).toBeGreaterThan(properSet.size);
    });

    test("should include basic tools in intern", () => {
      expect(PLAN_GATEWAY_SCOPES.intern).toContain("calendar.read");
      expect(PLAN_GATEWAY_SCOPES.intern).toContain("mail.draft");
      expect(PLAN_GATEWAY_SCOPES.intern).toContain("slack.post");
      expect(PLAN_GATEWAY_SCOPES.intern).toContain("comm.reply");
    });

    test("should NOT include always_human tools in intern", () => {
      expect(PLAN_GATEWAY_SCOPES.intern).not.toContain("mail.send");
      expect(PLAN_GATEWAY_SCOPES.intern).not.toContain("calendar.confirm");
      expect(PLAN_GATEWAY_SCOPES.intern).not.toContain("commerce.order");
    });

    test("should include mail.send and calendar.confirm in proper", () => {
      expect(PLAN_GATEWAY_SCOPES.proper).toContain("mail.send");
      expect(PLAN_GATEWAY_SCOPES.proper).toContain("calendar.confirm");
      expect(PLAN_GATEWAY_SCOPES.proper).toContain("commerce.quote");
    });

    test("should include commerce.order in executive only", () => {
      expect(PLAN_GATEWAY_SCOPES.intern).not.toContain("commerce.order");
      expect(PLAN_GATEWAY_SCOPES.proper).not.toContain("commerce.order");
      expect(PLAN_GATEWAY_SCOPES.executive).toContain("commerce.order");
    });
  });

  describe("PLAN_ADMIN_SCOPES", () => {
    test("should include LINE approval setup in intern (business decision)", () => {
      expect(PLAN_ADMIN_SCOPES.intern).toContain("setup.lineApproval.upsert");
      expect(PLAN_ADMIN_SCOPES.intern).toContain("setup.lineApproval.setEmployeeInbox");
    });

    test("should NOT include orgs.create in any plan (operator-only)", () => {
      expect(PLAN_ADMIN_SCOPES.intern).not.toContain("orgs.create");
      expect(PLAN_ADMIN_SCOPES.proper).not.toContain("orgs.create");
      expect(PLAN_ADMIN_SCOPES.executive).not.toContain("orgs.create");
    });

    test("should include policy.patch only in proper and executive", () => {
      expect(PLAN_ADMIN_SCOPES.intern).not.toContain("policy.patch");
      expect(PLAN_ADMIN_SCOPES.proper).toContain("policy.patch");
      expect(PLAN_ADMIN_SCOPES.executive).toContain("policy.patch");
    });

    test("should include advanced operations only in executive", () => {
      expect(PLAN_ADMIN_SCOPES.intern).not.toContain("ingressHandoff.patch");
      expect(PLAN_ADMIN_SCOPES.proper).not.toContain("ingressHandoff.patch");
      expect(PLAN_ADMIN_SCOPES.executive).toContain("ingressHandoff.patch");
    });
  });

  describe("READ_ONLY_ADMIN_TOOLS", () => {
    test("should contain only read-only operations", () => {
      READ_ONLY_ADMIN_TOOLS.forEach((tool) => {
        const isReadOnly =
          tool.endsWith(".get") ||
          tool.endsWith(".list") ||
          tool.endsWith(".status") ||
          tool.endsWith(".inspect") ||
          tool.includes("Status") ||
          tool.includes("Bindings") ||
          tool.startsWith("setup.connect");
        expect(isReadOnly).toBe(true);
      });
    });
  });

  describe("isGatewayToolAvailableForPlan", () => {
    test("should allow all tools for NULL plan (legacy)", () => {
      expect(isGatewayToolAvailableForPlan("commerce.order", null)).toBe(true);
      expect(isGatewayToolAvailableForPlan("browser.use", undefined)).toBe(true);
    });

    test("should fail closed for invalid plan", () => {
      expect(isGatewayToolAvailableForPlan("calendar.read", "invalid" as PlanKey)).toBe(false);
    });

    test("should respect plan scopes", () => {
      expect(isGatewayToolAvailableForPlan("calendar.read", "intern")).toBe(true);
      expect(isGatewayToolAvailableForPlan("mail.send", "intern")).toBe(false);
      expect(isGatewayToolAvailableForPlan("mail.send", "proper")).toBe(true);
      expect(isGatewayToolAvailableForPlan("commerce.order", "proper")).toBe(false);
      expect(isGatewayToolAvailableForPlan("commerce.order", "executive")).toBe(true);
    });
  });

  describe("isAdminToolAvailableForPlan", () => {
    test("should always allow read-only tools regardless of plan", () => {
      expect(isAdminToolAvailableForPlan("orgs.status", "intern")).toBe(true);
      expect(isAdminToolAvailableForPlan("approvalWorkflow.get", "intern")).toBe(true);
      expect(isAdminToolAvailableForPlan("stuckWatch.list", "intern")).toBe(true);
    });

    test("should allow all tools for NULL plan (legacy)", () => {
      expect(isAdminToolAvailableForPlan("ingressHandoff.patch", null)).toBe(true);
    });

    test("should fail closed for invalid plan", () => {
      expect(isAdminToolAvailableForPlan("employees.issue", "invalid" as PlanKey)).toBe(false);
    });

    test("should respect plan scopes for mutations", () => {
      expect(isAdminToolAvailableForPlan("policy.patch", "intern")).toBe(false);
      expect(isAdminToolAvailableForPlan("policy.patch", "proper")).toBe(true);
    });
  });

  describe("getRevokedGatewayTools", () => {
    test("should return empty for same plan", () => {
      expect(getRevokedGatewayTools("proper", "proper")).toEqual([]);
    });

    test("should return revoked tools on downgrade", () => {
      const revoked = getRevokedGatewayTools("proper", "intern");
      expect(revoked).toContain("mail.send");
      expect(revoked).toContain("calendar.confirm");
      expect(revoked).not.toContain("calendar.read");
    });

    test("should return empty on upgrade", () => {
      expect(getRevokedGatewayTools("intern", "proper")).toEqual([]);
    });

    test("should return tools on cancellation (to null)", () => {
      const revoked = getRevokedGatewayTools("intern", null);
      expect(revoked.length).toBe(PLAN_GATEWAY_SCOPES.intern.length);
    });
  });

  describe("getRevokedAdminTools", () => {
    test("should NOT revoke read-only tools", () => {
      const revoked = getRevokedAdminTools("executive", "intern");
      expect(revoked).not.toContain("orgs.status");
      expect(revoked).not.toContain("approvalWorkflow.get");
    });

    test("should revoke mutation tools on downgrade", () => {
      const revoked = getRevokedAdminTools("proper", "intern");
      expect(revoked).toContain("policy.patch");
    });
  });

  describe("getAddedGatewayTools", () => {
    test("should return added tools on upgrade", () => {
      const added = getAddedGatewayTools("intern", "proper");
      expect(added).toContain("mail.send");
      expect(added).toContain("calendar.confirm");
    });

    test("should return empty on downgrade", () => {
      expect(getAddedGatewayTools("proper", "intern")).toEqual([]);
    });
  });

  describe("Stripe integration", () => {
    test("should have lookup keys for all plans", () => {
      PLAN_KEYS.forEach((plan) => {
        expect(STRIPE_PRICE_LOOKUP_KEYS[plan]).toBeDefined();
        expect(STRIPE_PRICE_LOOKUP_KEYS[plan].monthly).toMatch(
          /^staffpass_plan_\w+_monthly$/
        );
        expect(STRIPE_PRICE_LOOKUP_KEYS[plan].yearly).toMatch(
          /^staffpass_plan_\w+_yearly$/
        );
      });
    });

    test("should have product IDs for all plans", () => {
      PLAN_KEYS.forEach((plan) => {
        expect(STRIPE_PRODUCT_IDS[plan]).toBeDefined();
        expect(STRIPE_PRODUCT_IDS[plan]).toMatch(/^prod_/);
      });
    });

    test("should resolve plan key from lookup key", () => {
      expect(resolvePlanKeyFromLookupKey("staffpass_plan_intern_monthly")).toBe("intern");
      expect(resolvePlanKeyFromLookupKey("staffpass_plan_proper_yearly")).toBe("proper");
      expect(resolvePlanKeyFromLookupKey("staffpass_plan_executive_monthly")).toBe("executive");
      expect(resolvePlanKeyFromLookupKey("unknown_key")).toBe(null);
      expect(resolvePlanKeyFromLookupKey(null)).toBe(null);
    });

    test("should resolve plan key from product ID", () => {
      expect(resolvePlanKeyFromProductId("prod_VMIoT9bpVDgzXL")).toBe("intern");
      expect(resolvePlanKeyFromProductId("prod_VMIoVllelHMMyh")).toBe("proper");
      expect(resolvePlanKeyFromProductId("prod_VMIo0WkobCbV7B")).toBe("executive");
      expect(resolvePlanKeyFromProductId("prod_unknown")).toBe(null);
    });
  });
});
