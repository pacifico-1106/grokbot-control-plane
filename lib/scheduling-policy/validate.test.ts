import { describe, expect, test } from "bun:test";
import {
  validateSchedulingPolicy,
  validateSchedulingRule,
  defaultSchedulingPolicy,
  normalizeSchedulingPolicy,
  isDefaultSchedulingPolicy,
  policyHasHighRiskAutomation,
  summarizeSchedulingPolicyJa,
  nextStepSchedulingPolicyJa,
} from "./validate";

describe("validateSchedulingRule", () => {
  test("valid rule with minimal fields", () => {
    const result = validateSchedulingRule(
      { confirmAutomation: "always_human" },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.confirmAutomation).toBe("always_human");
      expect(result.rule.id).toMatch(/^spr_/);
    }
  });

  test("valid rule with all fields", () => {
    const result = validateSchedulingRule(
      {
        id: "spr_custom",
        priority: 1,
        locationAffinity: "office_first",
        travelBufferMinutes: 30,
        onlinePack: {
          enabled: true,
          calendarTarget: "work@example.com",
          videoToolAllowlist: [
            { tool: "zoom", isDefault: true },
            { tool: "meet" },
          ],
        },
        hardBlackout: [
          { dayOfWeek: [0, 6], reason: "週末" },
          { startTime: "00:00", endTime: "09:00", reason: "営業時間外" },
        ],
        softPrefer: [
          { startTime: "10:00", endTime: "12:00", reason: "午前" },
        ],
        costCapJpy: 50000,
        confirmAutomation: "risk_based",
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.id).toBe("spr_custom");
      expect(result.rule.locationAffinity).toBe("office_first");
      expect(result.rule.travelBufferMinutes).toBe(30);
      expect(result.rule.onlinePack?.enabled).toBe(true);
      expect(result.rule.onlinePack?.videoToolAllowlist).toHaveLength(2);
      expect(result.rule.hardBlackout).toHaveLength(2);
      expect(result.rule.softPrefer).toHaveLength(1);
      expect(result.rule.costCapJpy).toBe(50000);
      expect(result.rule.confirmAutomation).toBe("risk_based");
    }
  });

  test("invalid confirmAutomation", () => {
    const result = validateSchedulingRule(
      { confirmAutomation: "invalid" },
      0
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("invalid_confirm_automation");
    }
  });

  test("invalid locationAffinity", () => {
    const result = validateSchedulingRule(
      { confirmAutomation: "always_human", locationAffinity: "invalid" },
      0
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("invalid_location_affinity");
    }
  });

  test("invalid travelBufferMinutes", () => {
    const result = validateSchedulingRule(
      { confirmAutomation: "always_human", travelBufferMinutes: -10 },
      0
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("invalid_travel_buffer");
    }
  });

  test("invalid costCapJpy", () => {
    const result = validateSchedulingRule(
      { confirmAutomation: "always_human", costCapJpy: -1000 },
      0
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("invalid_cost_cap");
    }
  });

  test("non-object input", () => {
    const result = validateSchedulingRule("not an object", 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("invalid_rule_format");
    }
  });
});

describe("validateSchedulingPolicy", () => {
  test("valid policy with minimal fields", () => {
    const result = validateSchedulingPolicy({
      rules: [{ confirmAutomation: "always_human" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.policyId).toMatch(/^sp_/);
      expect(result.policy.rules).toHaveLength(1);
    }
  });

  test("valid policy with policyName", () => {
    const result = validateSchedulingPolicy({
      policyName: "カスタムポリシー",
      rules: [{ confirmAutomation: "always_human" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.policyName).toBe("カスタムポリシー");
    }
  });

  test("empty rules array", () => {
    const result = validateSchedulingPolicy({ rules: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("rules_empty");
    }
  });

  test("missing rules", () => {
    const result = validateSchedulingPolicy({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("rules_required");
    }
  });

  test("high-risk automation without consent - requireHighRiskConsent=true", () => {
    const result = validateSchedulingPolicy(
      {
        rules: [{ confirmAutomation: "full_auto" }],
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "high_risk_consent_required")).toBe(
        true
      );
    }
  });

  test("high-risk automation with consent", () => {
    const result = validateSchedulingPolicy(
      {
        rules: [{ confirmAutomation: "full_auto" }],
        highRiskConsentAt: "2026-09-07T00:00:00Z",
        highRiskConsentBy: "admin@example.com",
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.highRiskConsentAt).toBe("2026-09-07T00:00:00Z");
      expect(result.policy.highRiskConsentBy).toBe("admin@example.com");
    }
  });

  test("high-risk automation with existing consent", () => {
    const result = validateSchedulingPolicy(
      {
        rules: [{ confirmAutomation: "full_auto" }],
      },
      {
        requireHighRiskConsent: true,
        existingConsent: { at: "2026-09-06T00:00:00Z", by: "prev@example.com" },
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.highRiskConsentAt).toBe("2026-09-06T00:00:00Z");
      expect(result.policy.highRiskConsentBy).toBe("prev@example.com");
    }
  });

  test("always_human does not require consent", () => {
    const result = validateSchedulingPolicy(
      {
        rules: [{ confirmAutomation: "always_human" }],
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(true);
  });
});

describe("defaultSchedulingPolicy", () => {
  test("returns default policy", () => {
    const policy = defaultSchedulingPolicy();
    expect(policy.version).toBe(1);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].confirmAutomation).toBe("always_human");
  });
});

describe("normalizeSchedulingPolicy", () => {
  test("normalizes valid policy", () => {
    const policy = normalizeSchedulingPolicy({
      policyId: "sp_test",
      policyName: "Test",
      rules: [{ confirmAutomation: "always_human" }],
    });
    expect(policy.policyId).toBe("sp_test");
    expect(policy.policyName).toBe("Test");
  });

  test("returns default for invalid input", () => {
    const policy = normalizeSchedulingPolicy(null);
    expect(policy.policyId).toMatch(/^sp_/);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].confirmAutomation).toBe("always_human");
  });

  test("returns default for empty rules", () => {
    const policy = normalizeSchedulingPolicy({ rules: [] });
    expect(policy.rules).toHaveLength(1);
  });
});

describe("isDefaultSchedulingPolicy", () => {
  test("recognizes default policy", () => {
    const policy = defaultSchedulingPolicy();
    expect(isDefaultSchedulingPolicy(policy)).toBe(true);
  });

  test("recognizes non-default policy", () => {
    const policy = normalizeSchedulingPolicy({
      rules: [
        { confirmAutomation: "always_human", travelBufferMinutes: 30 },
      ],
    });
    expect(isDefaultSchedulingPolicy(policy)).toBe(false);
  });

  test("recognizes policy with multiple rules as non-default", () => {
    const policy = normalizeSchedulingPolicy({
      rules: [
        { confirmAutomation: "always_human" },
        { confirmAutomation: "risk_based" },
      ],
    });
    expect(isDefaultSchedulingPolicy(policy)).toBe(false);
  });
});

describe("policyHasHighRiskAutomation", () => {
  test("always_human is not high risk", () => {
    const policy = normalizeSchedulingPolicy({
      rules: [{ confirmAutomation: "always_human" }],
    });
    expect(policyHasHighRiskAutomation(policy)).toBe(false);
  });

  test("risk_based is high risk", () => {
    const policy = normalizeSchedulingPolicy({
      rules: [{ confirmAutomation: "risk_based" }],
    });
    expect(policyHasHighRiskAutomation(policy)).toBe(true);
  });

  test("conditional is high risk", () => {
    const policy = normalizeSchedulingPolicy({
      rules: [{ confirmAutomation: "conditional" }],
    });
    expect(policyHasHighRiskAutomation(policy)).toBe(true);
  });

  test("full_auto is high risk", () => {
    const policy = normalizeSchedulingPolicy({
      rules: [{ confirmAutomation: "full_auto" }],
    });
    expect(policyHasHighRiskAutomation(policy)).toBe(true);
  });
});

describe("summarizeSchedulingPolicyJa", () => {
  test("summarizes default policy", () => {
    const policy = defaultSchedulingPolicy();
    const summary = summarizeSchedulingPolicyJa(policy);
    expect(summary).toContain("デフォルト");
    expect(summary).toContain("always_human");
  });

  test("summarizes custom policy", () => {
    const policy = normalizeSchedulingPolicy({
      rules: [
        {
          confirmAutomation: "risk_based",
          locationAffinity: "office_first",
          travelBufferMinutes: 30,
        },
      ],
    });
    const summary = summarizeSchedulingPolicyJa(policy);
    expect(summary).toContain("オフィス優先");
    expect(summary).toContain("リスクベース");
    expect(summary).toContain("移動30分");
  });
});

describe("nextStepSchedulingPolicyJa", () => {
  test("default policy guidance", () => {
    const policy = defaultSchedulingPolicy();
    const next = nextStepSchedulingPolicyJa(policy);
    expect(next).toContain("デフォルト");
  });

  test("high-risk without consent guidance", () => {
    const policy = normalizeSchedulingPolicy({
      rules: [{ confirmAutomation: "full_auto" }],
    });
    const next = nextStepSchedulingPolicyJa(policy);
    expect(next).toContain("承諾が未記録");
  });

  test("high-risk with consent guidance", () => {
    const policy: ReturnType<typeof normalizeSchedulingPolicy> = {
      ...normalizeSchedulingPolicy({
        rules: [{ confirmAutomation: "full_auto" }],
      }),
      highRiskConsentAt: "2026-09-07T00:00:00Z",
      highRiskConsentBy: "admin@example.com",
    };
    const next = nextStepSchedulingPolicyJa(policy);
    expect(next).toContain("有効です");
    expect(next).toContain("admin@example.com");
  });
});
