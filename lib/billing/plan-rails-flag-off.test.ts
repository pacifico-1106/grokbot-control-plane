/**
 * P1 Plan Rails — Flag OFF Regression Tests
 *
 * Verifies that when P1_PLAN_RAILS_ENABLED is OFF:
 * 1. All tools remain available (no filtering)
 * 2. Behavior is byte-identical to pre-rails
 * 3. No plan checks block anything
 *
 * SECURITY INVARIANT: Flag OFF must not change any existing behavior.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

const ORIGINAL_ENV = process.env.P1_PLAN_RAILS_ENABLED;

function disablePlanRails() {
  process.env.P1_PLAN_RAILS_ENABLED = "";
}

function enablePlanRails() {
  process.env.P1_PLAN_RAILS_ENABLED = "true";
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.P1_PLAN_RAILS_ENABLED;
  } else {
    process.env.P1_PLAN_RAILS_ENABLED = ORIGINAL_ENV;
  }
}

describe("P1 Plan Rails — Flag OFF Regression", () => {
  beforeEach(() => {
    disablePlanRails();
  });

  afterEach(() => {
    restoreEnv();
  });

  describe("isPlanRailsEnabled", () => {
    test("should return false when flag is OFF", async () => {
      const { isPlanRailsEnabled } = await import("@/lib/feature-flags");
      expect(isPlanRailsEnabled()).toBe(false);
    });

    test("should return false for empty string", async () => {
      process.env.P1_PLAN_RAILS_ENABLED = "";
      const { isPlanRailsEnabled } = await import("@/lib/feature-flags");
      expect(isPlanRailsEnabled()).toBe(false);
    });

    test("should return false for 'false'", async () => {
      process.env.P1_PLAN_RAILS_ENABLED = "false";
      const { isPlanRailsEnabled } = await import("@/lib/feature-flags");
      expect(isPlanRailsEnabled()).toBe(false);
    });

    test("should return true when flag is ON", async () => {
      enablePlanRails();
      const { isPlanRailsEnabled } = await import("@/lib/feature-flags");
      expect(isPlanRailsEnabled()).toBe(true);
    });
  });

  describe("plan-gate helpers with flag OFF", () => {
    test("assertGatewayToolAllowedForPlan should always return ok=true when flag OFF", async () => {
      const { assertGatewayToolAllowedForPlan } = await import("./plan-gate");
      
      const result = await assertGatewayToolAllowedForPlan("test-org", "commerce.order");
      expect(result.ok).toBe(true);
      
      const result2 = await assertGatewayToolAllowedForPlan("test-org", "browser.use");
      expect(result2.ok).toBe(true);
      
      const result3 = await assertGatewayToolAllowedForPlan("test-org", "sns.publish");
      expect(result3.ok).toBe(true);
    });

    test("assertAdminToolAllowedForPlan should always return ok=true when flag OFF", async () => {
      const { assertAdminToolAllowedForPlan } = await import("./plan-gate");
      
      const result = await assertAdminToolAllowedForPlan("test-org", "ingressHandoff.patch");
      expect(result.ok).toBe(true);
      
      const result2 = await assertAdminToolAllowedForPlan("test-org", "policy.patch");
      expect(result2.ok).toBe(true);
    });
  });

  describe("plan-api-gate helpers with flag OFF", () => {
    test("assertApiPlanAllows should always return ok=true when flag OFF", async () => {
      const { assertApiPlanAllows } = await import("./plan-api-gate");
      
      const result = await assertApiPlanAllows("test-org", "approval_routes", "承認ルート");
      expect(result.ok).toBe(true);
      
      const result2 = await assertApiPlanAllows("test-org", "policy_editor", "ポリシー");
      expect(result2.ok).toBe(true);
    });

    test("assertApiGatewayToolAllowed should always return ok=true when flag OFF", async () => {
      const { assertApiGatewayToolAllowed } = await import("./plan-api-gate");
      
      const result = await assertApiGatewayToolAllowed("test-org", "commerce.order");
      expect(result.ok).toBe(true);
    });

    test("assertApiAdminToolAllowed should always return ok=true when flag OFF", async () => {
      const { assertApiAdminToolAllowed } = await import("./plan-api-gate");
      
      const result = await assertApiAdminToolAllowed("test-org", "ingressHandoff.patch");
      expect(result.ok).toBe(true);
    });
  });

  describe("plan-ui helpers with flag OFF", () => {
    test("isUiFeatureAvailable should always return true when flag OFF", async () => {
      const { isUiFeatureAvailable } = await import("./plan-ui");
      
      expect(isUiFeatureAvailable("approval_routes", "intern", false)).toBe(true);
      expect(isUiFeatureAvailable("audit_export", "intern", false)).toBe(true);
      expect(isUiFeatureAvailable("external_sharing", "intern", false)).toBe(true);
    });

    test("isGatewayToolAvailableForPlanUi should always return true when flag OFF", async () => {
      const { isGatewayToolAvailableForPlanUi } = await import("./plan-ui");
      
      expect(isGatewayToolAvailableForPlanUi("commerce.order", "intern", false)).toBe(true);
      expect(isGatewayToolAvailableForPlanUi("browser.use", "intern", false)).toBe(true);
    });

    test("isAdminToolAvailableForPlanUi should always return true when flag OFF", async () => {
      const { isAdminToolAvailableForPlanUi } = await import("./plan-ui");
      
      expect(isAdminToolAvailableForPlanUi("ingressHandoff.patch", "intern", false)).toBe(true);
      expect(isAdminToolAvailableForPlanUi("policy.patch", "intern", false)).toBe(true);
    });
  });

  describe("plan-change-handler with flag OFF", () => {
    test("handlePlanDowngrade should be no-op when flag OFF", async () => {
      const { handlePlanDowngrade } = await import("./plan-change-handler");
      
      const result = await handlePlanDowngrade(
        "test-org",
        "executive",
        "intern",
        new Date().toISOString()
      );
      
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe("no_change");
      }
    });

    test("applyScheduledDowngrade should be no-op when flag OFF", async () => {
      const { applyScheduledDowngrade } = await import("./plan-change-handler");
      
      const result = await applyScheduledDowngrade("test-org");
      
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe("no_change");
      }
    });

    test("cancelScheduledDowngrade should be no-op when flag OFF", async () => {
      const { cancelScheduledDowngrade } = await import("./plan-change-handler");
      
      const result = await cancelScheduledDowngrade("test-org");
      
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe("no_change");
      }
    });

    test("applyImmediatePlanChange should be no-op when flag OFF", async () => {
      const { applyImmediatePlanChange } = await import("./plan-change-handler");
      
      const result = await applyImmediatePlanChange("test-org", "intern");
      
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe("no_change");
      }
    });
  });

  describe("plan-upgrade-handler with flag OFF", () => {
    test("createUpgradeTicket should be no-op when flag OFF", async () => {
      const { createUpgradeTicket } = await import("./plan-upgrade-handler");
      
      const result = await createUpgradeTicket({
        orgId: "test-org",
        currentPlan: "intern",
        newPlan: "executive",
        source: "web_api",
      });
      
      expect(result.ok).toBe(true);
      expect(result.ticketId).toBeUndefined();
    });

    test("applyApprovedUpgrade should be no-op when flag OFF", async () => {
      const { applyApprovedUpgrade } = await import("./plan-upgrade-handler");
      
      const result = await applyApprovedUpgrade(
        "test-ticket",
        "test-org",
        "test-approval",
        "test@example.com"
      );
      
      expect(result.ok).toBe(true);
    });
  });

  describe("plan-fulfill-recheck with flag OFF", () => {
    test("recheckGatewayToolAtFulfill should always return ok=true when flag OFF", async () => {
      const { recheckGatewayToolAtFulfill } = await import("./plan-fulfill-recheck");
      
      const mockApproval = {
        id: "test",
        orgId: "test-org",
        employeeId: "emp",
        credentialId: "cred",
        tool: "commerce.order",
        title: "Test",
        purpose: "test",
        summary: "Test",
        risk: "high" as const,
        status: "approved" as const,
        createdAt: new Date().toISOString(),
        pollPath: "/poll",
        revisionNote: null,
        revisionCount: 0,
        parentApprovalId: null,
        telegramRef: null,
        telegramMessageId: null,
        statusToken: "test-token",
        jobId: null,
        resolvedAt: null,
        resolvedBy: null,
        metadata: {},
      };
      
      const result = await recheckGatewayToolAtFulfill("test-org", "commerce.order", mockApproval);
      expect(result.ok).toBe(true);
    });

    test("recheckAdminToolAtFulfill should always return ok=true when flag OFF", async () => {
      const { recheckAdminToolAtFulfill } = await import("./plan-fulfill-recheck");
      
      const mockApproval = {
        id: "test",
        orgId: "test-org",
        employeeId: "emp",
        credentialId: "cred",
        tool: "ingressHandoff.patch",
        title: "Test",
        purpose: "test",
        summary: "Test",
        risk: "high" as const,
        status: "approved" as const,
        createdAt: new Date().toISOString(),
        pollPath: "/poll",
        revisionNote: null,
        revisionCount: 0,
        parentApprovalId: null,
        telegramRef: null,
        telegramMessageId: null,
        statusToken: "test-token",
        jobId: null,
        resolvedAt: null,
        resolvedBy: null,
        metadata: {},
      };
      
      const result = await recheckAdminToolAtFulfill("test-org", "ingressHandoff.patch", mockApproval);
      expect(result.ok).toBe(true);
    });
  });
});

describe("P1 Plan Rails — Flag ON Behavior", () => {
  beforeEach(() => {
    enablePlanRails();
  });

  afterEach(() => {
    restoreEnv();
  });

  describe("plan-ui helpers with flag ON", () => {
    test("isUiFeatureAvailable should respect plan scopes when flag ON", async () => {
      const { isUiFeatureAvailable } = await import("./plan-ui");
      
      expect(isUiFeatureAvailable("approval_routes", "intern", true)).toBe(false);
      expect(isUiFeatureAvailable("approval_routes", "proper", true)).toBe(true);
      
      expect(isUiFeatureAvailable("audit_export", "intern", true)).toBe(false);
      expect(isUiFeatureAvailable("audit_export", "executive", true)).toBe(true);
    });

    test("isUiFeatureAvailable should allow all for legacy (null) plan", async () => {
      const { isUiFeatureAvailable } = await import("./plan-ui");
      
      expect(isUiFeatureAvailable("approval_routes", null, true)).toBe(true);
      expect(isUiFeatureAvailable("audit_export", null, true)).toBe(true);
    });
  });
});
