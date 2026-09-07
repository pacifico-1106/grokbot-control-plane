import { describe, expect, test } from "bun:test";
import {
  validateRule,
  validateIngressHandoffPolicy,
  normalizeIngressHandoffPolicy,
  defaultIngressHandoffPolicy,
  isDefaultIngressHandoffPolicy,
  summarizeIngressHandoffPolicyJa,
  nextStepIngressHandoffJa,
  policyHasHighRiskAutomation,
  hasHighRiskConsentRecorded,
  DEFAULT_INGRESS_HANDOFF_RULE,
} from "./validate";

describe("validateRule", () => {
  test("valid minimal rule passes", () => {
    const result = validateRule(
      {
        applyTo: "all",
        body: "full",
        attachment: "meta",
        sealith: "off",
        audit: { jobId: true, sealithTransferId: false },
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.applyTo).toBe("all");
      expect(result.rule.body).toBe("full");
      expect(result.rule.attachment).toBe("meta");
      expect(result.rule.sealith).toBe("off");
      expect(result.rule.audit.jobId).toBe(true);
      expect(result.rule.audit.sealithTransferId).toBe(false);
    }
  });

  test("rule with channels requires channelIds", () => {
    const result = validateRule(
      {
        applyTo: "channels",
        body: "full",
        attachment: "meta",
        sealith: "off",
      },
      0
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "channel_ids_required")).toBe(true);
    }
  });

  test("rule with channels and valid channelIds passes", () => {
    const result = validateRule(
      {
        applyTo: "channels",
        channelIds: ["C123", "C456"],
        body: "full",
        attachment: "meta",
        sealith: "off",
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.channelIds).toEqual(["C123", "C456"]);
    }
  });

  test("body=prefix requires bodyPrefixChars", () => {
    const result = validateRule(
      {
        applyTo: "all",
        body: "prefix",
        attachment: "meta",
        sealith: "off",
      },
      0
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "invalid_body_prefix_chars")).toBe(true);
    }
  });

  test("body=prefix with valid bodyPrefixChars passes", () => {
    const result = validateRule(
      {
        applyTo: "all",
        body: "prefix",
        bodyPrefixChars: 500,
        attachment: "meta",
        sealith: "off",
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.bodyPrefixChars).toBe(500);
    }
  });

  test("bodyPrefixChars out of range fails", () => {
    const resultLow = validateRule(
      {
        applyTo: "all",
        body: "prefix",
        bodyPrefixChars: 0,
        attachment: "meta",
        sealith: "off",
      },
      0
    );
    expect(resultLow.ok).toBe(false);

    const resultHigh = validateRule(
      {
        applyTo: "all",
        body: "prefix",
        bodyPrefixChars: 5000,
        attachment: "meta",
        sealith: "off",
      },
      0
    );
    expect(resultHigh.ok).toBe(false);
  });

  test("attachment=none strips attachmentApproval", () => {
    const result = validateRule(
      {
        applyTo: "all",
        body: "full",
        attachment: "none",
        attachmentApproval: "manager",
        sealith: "off",
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.attachmentApproval).toBeUndefined();
    }
  });

  test("sealith=off forces sealithTransferId false", () => {
    const result = validateRule(
      {
        applyTo: "all",
        body: "full",
        attachment: "meta",
        sealith: "off",
        audit: { jobId: true, sealithTransferId: true },
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.audit.sealithTransferId).toBe(false);
    }
  });

  test("sealith=required allows sealithTransferId true", () => {
    const result = validateRule(
      {
        applyTo: "all",
        body: "full",
        attachment: "file",
        sealith: "required",
        sealithRequiredHints: ["contract", "nda"],
        audit: { jobId: true, sealithTransferId: true },
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.sealith).toBe("required");
      expect(result.rule.sealithRequiredHints).toEqual(["contract", "nda"]);
      expect(result.rule.audit.sealithTransferId).toBe(true);
    }
  });

  test("invalid applyTo fails", () => {
    const result = validateRule(
      {
        applyTo: "invalid",
        body: "full",
        attachment: "meta",
        sealith: "off",
      },
      0
    );
    expect(result.ok).toBe(false);
  });

  test("invalid body fails", () => {
    const result = validateRule(
      {
        applyTo: "all",
        body: "invalid",
        attachment: "meta",
        sealith: "off",
      },
      0
    );
    expect(result.ok).toBe(false);
  });

  test("non-object rule fails", () => {
    const result = validateRule("not an object", 0);
    expect(result.ok).toBe(false);
  });
});

describe("validateIngressHandoffPolicy", () => {
  test("valid policy with one rule passes", () => {
    const result = validateIngressHandoffPolicy({
      rules: [
        {
          applyTo: "all",
          body: "full",
          attachment: "meta",
          sealith: "off",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.version).toBe(1);
      expect(result.policy.policyId).toMatch(/^ihp_/);
      expect(result.policy.policyName).toBe("受信の渡し方ポリシー");
      expect(result.policy.rules.length).toBe(1);
      expect(result.policy.updatedBy).toBe("admin_mcp");
    }
  });

  test("preserves provided policyName", () => {
    const result = validateIngressHandoffPolicy({
      policyName: "外部向け厳格ポリシー",
      rules: [
        {
          applyTo: "all",
          body: "full",
          attachment: "meta",
          sealith: "off",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.policyName).toBe("外部向け厳格ポリシー");
    }
  });

  test("empty rules array fails", () => {
    const result = validateIngressHandoffPolicy({ rules: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "rules_empty")).toBe(true);
    }
  });

  test("missing rules fails", () => {
    const result = validateIngressHandoffPolicy({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "rules_required")).toBe(true);
    }
  });

  test("multiple rules pass with first-match ordering preserved", () => {
    const result = validateIngressHandoffPolicy({
      rules: [
        {
          applyTo: "classified_external_sensitive",
          body: "prefix",
          bodyPrefixChars: 100,
          attachment: "none",
          sealith: "required",
        },
        {
          applyTo: "all",
          body: "full",
          attachment: "meta",
          sealith: "off",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.rules.length).toBe(2);
      expect(result.policy.rules[0].applyTo).toBe("classified_external_sensitive");
      expect(result.policy.rules[1].applyTo).toBe("all");
    }
  });

  test("invalid policy format fails", () => {
    const result = validateIngressHandoffPolicy(null);
    expect(result.ok).toBe(false);
  });
});

describe("normalizeIngressHandoffPolicy", () => {
  test("null returns default", () => {
    const policy = normalizeIngressHandoffPolicy(null);
    expect(policy.rules.length).toBe(1);
    expect(policy.rules[0].applyTo).toBe("all");
  });

  test("empty rules returns default", () => {
    const policy = normalizeIngressHandoffPolicy({ rules: [] });
    expect(policy.rules.length).toBe(1);
  });

  test("valid policy is normalized", () => {
    const policy = normalizeIngressHandoffPolicy({
      rules: [
        {
          applyTo: "all",
          body: "none",
          attachment: "none",
          sealith: "off",
        },
      ],
    });
    expect(policy.rules.length).toBe(1);
    expect(policy.rules[0].body).toBe("none");
  });
});

describe("defaultIngressHandoffPolicy", () => {
  test("returns convenience default", () => {
    const policy = defaultIngressHandoffPolicy();
    expect(policy.version).toBe(1);
    expect(policy.policyId).toMatch(/^ihp_/);
    expect(policy.policyName).toBe("デフォルト（便利設定）");
    expect(policy.rules.length).toBe(1);
    expect(policy.rules[0].applyTo).toBe("all");
    expect(policy.rules[0].body).toBe("full");
    expect(policy.rules[0].attachment).toBe("meta");
    expect(policy.rules[0].sealith).toBe("off");
    expect(policy.updatedBy).toBe("admin_mcp");
  });
});

describe("isDefaultIngressHandoffPolicy", () => {
  test("default policy is recognized", () => {
    expect(isDefaultIngressHandoffPolicy(defaultIngressHandoffPolicy())).toBe(true);
  });

  test("custom policy is not default", () => {
    const custom = normalizeIngressHandoffPolicy({
      rules: [
        {
          applyTo: "all",
          body: "none",
          attachment: "none",
          sealith: "off",
        },
      ],
    });
    expect(isDefaultIngressHandoffPolicy(custom)).toBe(false);
  });

  test("multiple rules is not default", () => {
    const policy = normalizeIngressHandoffPolicy({
      rules: [
        { ...DEFAULT_INGRESS_HANDOFF_RULE },
        { ...DEFAULT_INGRESS_HANDOFF_RULE, applyTo: "channels", channelIds: ["C1"] },
      ],
    });
    expect(isDefaultIngressHandoffPolicy(policy)).toBe(false);
  });
});

describe("summarizeIngressHandoffPolicyJa", () => {
  test("default policy summary", () => {
    const summary = summarizeIngressHandoffPolicyJa(defaultIngressHandoffPolicy());
    expect(summary).toContain("デフォルト");
  });

  test("custom policy summary", () => {
    const policy = normalizeIngressHandoffPolicy({
      rules: [
        {
          applyTo: "classified_external_sensitive",
          body: "prefix",
          bodyPrefixChars: 100,
          attachment: "none",
          sealith: "required",
        },
      ],
    });
    const summary = summarizeIngressHandoffPolicyJa(policy);
    expect(summary).toContain("外部/機密分類");
    expect(summary).toContain("先頭100文字");
    expect(summary).toContain("必須");
  });
});

describe("nextStepIngressHandoffJa", () => {
  test("default policy guidance", () => {
    const next = nextStepIngressHandoffJa(defaultIngressHandoffPolicy());
    expect(next).toContain("デフォルト");
  });

  test("sealith required guidance", () => {
    const policy = normalizeIngressHandoffPolicy({
      rules: [
        {
          applyTo: "all",
          body: "full",
          attachment: "file",
          sealith: "required",
        },
      ],
    });
    const next = nextStepIngressHandoffJa(policy);
    expect(next).toContain("Sealith必須");
  });

  test("manager approval guidance", () => {
    const policy = normalizeIngressHandoffPolicy({
      rules: [
        {
          applyTo: "all",
          body: "full",
          attachment: "file",
          attachmentApproval: "manager",
          sealith: "off",
        },
      ],
    });
    const next = nextStepIngressHandoffJa(policy);
    expect(next).toContain("上長承認");
  });

  test("high risk without consent guidance", () => {
    const policy = normalizeIngressHandoffPolicy({
      rules: [
        {
          applyTo: "classified_external_sensitive",
          body: "full",
          attachment: "file",
          sealith: "off",
        },
      ],
    });
    const next = nextStepIngressHandoffJa(policy);
    expect(next).toContain("高リスク警告");
  });
});

describe("policyHasHighRiskAutomation", () => {
  test("returns false for default policy", () => {
    expect(policyHasHighRiskAutomation(defaultIngressHandoffPolicy())).toBe(false);
  });

  test("returns false for file+sealith=off on all scope", () => {
    const policy = {
      rules: [
        {
          id: "test",
          applyTo: "all" as const,
          body: "full" as const,
          attachment: "file" as const,
          sealith: "off" as const,
          audit: { jobId: true, sealithTransferId: false },
        },
      ],
    };
    expect(policyHasHighRiskAutomation(policy)).toBe(false);
  });

  test("returns true for file+sealith=off on classified_external_sensitive", () => {
    const policy = {
      rules: [
        {
          id: "test",
          applyTo: "classified_external_sensitive" as const,
          body: "full" as const,
          attachment: "file" as const,
          sealith: "off" as const,
          audit: { jobId: true, sealithTransferId: false },
        },
      ],
    };
    expect(policyHasHighRiskAutomation(policy)).toBe(true);
  });

  test("returns false when sealith is required", () => {
    const policy = {
      rules: [
        {
          id: "test",
          applyTo: "classified_external_sensitive" as const,
          body: "full" as const,
          attachment: "file" as const,
          sealith: "required" as const,
          audit: { jobId: true, sealithTransferId: true },
        },
      ],
    };
    expect(policyHasHighRiskAutomation(policy)).toBe(false);
  });

  test("returns false when attachment is meta", () => {
    const policy = {
      rules: [
        {
          id: "test",
          applyTo: "classified_external_sensitive" as const,
          body: "full" as const,
          attachment: "meta" as const,
          sealith: "off" as const,
          audit: { jobId: true, sealithTransferId: false },
        },
      ],
    };
    expect(policyHasHighRiskAutomation(policy)).toBe(false);
  });
});

describe("high-risk consent validation", () => {
  test("rejects high-risk config without consent when required", () => {
    const result = validateIngressHandoffPolicy(
      {
        rules: [
          {
            applyTo: "classified_external_sensitive",
            body: "full",
            attachment: "file",
            sealith: "off",
          },
        ],
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "high_risk_consent_required")).toBe(true);
    }
  });

  test("accepts high-risk config with new consent", () => {
    const result = validateIngressHandoffPolicy(
      {
        rules: [
          {
            applyTo: "classified_external_sensitive",
            body: "full",
            attachment: "file",
            sealith: "off",
          },
        ],
        highRiskConsentAt: new Date().toISOString(),
        highRiskConsentBy: "admin@example.com",
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.highRiskConsentAt).toBeDefined();
      expect(result.policy.highRiskConsentBy).toBe("admin@example.com");
    }
  });

  test("accepts high-risk config with existing consent", () => {
    const result = validateIngressHandoffPolicy(
      {
        rules: [
          {
            applyTo: "classified_external_sensitive",
            body: "full",
            attachment: "file",
            sealith: "off",
          },
        ],
      },
      {
        requireHighRiskConsent: true,
        existingConsent: {
          at: "2026-09-01T00:00:00Z",
          by: "previous@example.com",
        },
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.highRiskConsentAt).toBe("2026-09-01T00:00:00Z");
    }
  });

  test("does not require consent for non-high-risk config", () => {
    const result = validateIngressHandoffPolicy(
      {
        rules: [
          {
            applyTo: "classified_external_sensitive",
            body: "full",
            attachment: "meta",
            sealith: "off",
          },
        ],
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(true);
  });

  test("does not require consent when requireHighRiskConsent is false", () => {
    const result = validateIngressHandoffPolicy(
      {
        rules: [
          {
            applyTo: "classified_external_sensitive",
            body: "full",
            attachment: "file",
            sealith: "off",
          },
        ],
      },
      { requireHighRiskConsent: false }
    );
    expect(result.ok).toBe(true);
  });
});

describe("hasHighRiskConsentRecorded", () => {
  test("returns false when no consent", () => {
    expect(hasHighRiskConsentRecorded(defaultIngressHandoffPolicy())).toBe(false);
  });

  test("returns true when consent recorded", () => {
    const policy = normalizeIngressHandoffPolicy({
      rules: [
        {
          applyTo: "classified_external_sensitive",
          body: "full",
          attachment: "file",
          sealith: "off",
        },
      ],
      highRiskConsentAt: "2026-09-01T00:00:00Z",
      highRiskConsentBy: "admin@example.com",
    });
    expect(hasHighRiskConsentRecorded(policy)).toBe(true);
  });
});
