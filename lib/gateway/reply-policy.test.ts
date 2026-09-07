import { describe, expect, test } from "bun:test";
import {
  evaluateReplyPolicy,
  applyEmojiPolicy,
  shouldDraftOnly,
  shouldHoldForApproval,
  summarizeReplyPolicyDecision,
  isAfterBusinessHours,
  defaultReplyPolicy,
} from "@/lib/gateway/reply-policy";
import {
  validateReplyPolicy,
  validateReplyPolicyRule,
  normalizeReplyPolicy,
  isDefaultReplyPolicy,
  policyHasHighRiskAutoSend,
  summarizeReplyPolicyJa,
  nextStepReplyPolicyJa,
} from "@/lib/gateway/reply-policy-validate";
import type { OrgReplyPolicy, ReplyPolicyRule } from "@/lib/types";

describe("validateReplyPolicyRule", () => {
  test("validates valid rule with all fields", () => {
    const result = validateReplyPolicyRule(
      {
        id: "test_rule",
        afterHoursMode: "draft_only",
        shortReplyMode: "allow",
        emojiMode: "limited",
        threadAffinity: "prefer_thread",
        businessHours: {
          dayOfWeek: [1, 2, 3, 4, 5],
          startTime: "09:00",
          endTime: "18:00",
        },
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.afterHoursMode).toBe("draft_only");
      expect(result.rule.businessHours?.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    }
  });

  test("rejects invalid afterHoursMode", () => {
    const result = validateReplyPolicyRule(
      {
        afterHoursMode: "invalid",
        shortReplyMode: "allow",
        emojiMode: "allow",
        threadAffinity: "prefer_thread",
      },
      0
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "invalid_after_hours_mode")).toBe(true);
    }
  });

  test("rejects invalid business hours format", () => {
    const result = validateReplyPolicyRule(
      {
        afterHoursMode: "draft_only",
        shortReplyMode: "allow",
        emojiMode: "allow",
        threadAffinity: "prefer_thread",
        businessHours: {
          dayOfWeek: [7],
          startTime: "9:00",
          endTime: "18:00",
        },
      },
      0
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "invalid_business_hours")).toBe(true);
    }
  });

  test("generates rule id if not provided", () => {
    const result = validateReplyPolicyRule(
      {
        afterHoursMode: "draft_only",
        shortReplyMode: "allow",
        emojiMode: "allow",
        threadAffinity: "prefer_thread",
      },
      0
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule.id).toMatch(/^rpr_/);
    }
  });
});

describe("validateReplyPolicy", () => {
  test("validates valid policy", () => {
    const result = validateReplyPolicy({
      policyName: "テストポリシー",
      rules: [
        {
          afterHoursMode: "draft_only",
          shortReplyMode: "allow",
          emojiMode: "limited",
          threadAffinity: "prefer_thread",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.policyName).toBe("テストポリシー");
      expect(result.policy.rules.length).toBe(1);
    }
  });

  test("rejects empty rules array", () => {
    const result = validateReplyPolicy({
      rules: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "rules_empty")).toBe(true);
    }
  });

  test("requires high-risk consent for allow_send after hours", () => {
    const result = validateReplyPolicy(
      {
        rules: [
          {
            afterHoursMode: "allow_send",
            shortReplyMode: "allow",
            emojiMode: "allow",
            threadAffinity: "prefer_thread",
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

  test("accepts high-risk with consent", () => {
    const result = validateReplyPolicy(
      {
        rules: [
          {
            afterHoursMode: "allow_send",
            shortReplyMode: "allow",
            emojiMode: "allow",
            threadAffinity: "prefer_thread",
          },
        ],
        highRiskConsentAt: "2026-09-08T00:00:00Z",
        highRiskConsentBy: "admin@example.com",
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(true);
  });
});

describe("normalizeReplyPolicy", () => {
  test("normalizes valid policy", () => {
    const policy = normalizeReplyPolicy({
      policyId: "test",
      policyName: "Test",
      rules: [
        {
          afterHoursMode: "draft_only",
          shortReplyMode: "allow",
          emojiMode: "allow",
          threadAffinity: "prefer_thread",
        },
      ],
    });
    expect(policy.policyId).toBe("test");
    expect(policy.rules.length).toBe(1);
  });

  test("returns default for invalid input", () => {
    const policy = normalizeReplyPolicy(null);
    expect(policy.rules.length).toBeGreaterThan(0);
    expect(policy.rules[0].afterHoursMode).toBe("draft_only");
  });
});

describe("isDefaultReplyPolicy", () => {
  test("identifies default policy", () => {
    const policy = defaultReplyPolicy();
    expect(isDefaultReplyPolicy(policy)).toBe(true);
  });

  test("identifies non-default policy", () => {
    const policy: OrgReplyPolicy = {
      version: 1,
      policyId: "custom",
      policyName: "Custom",
      rules: [
        {
          id: "r1",
          afterHoursMode: "allow_send",
          shortReplyMode: "deny",
          emojiMode: "deny",
          threadAffinity: "channel_root",
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "admin",
    };
    expect(isDefaultReplyPolicy(policy)).toBe(false);
  });
});

describe("policyHasHighRiskAutoSend", () => {
  test("detects allow_send", () => {
    const policy: OrgReplyPolicy = {
      version: 1,
      policyId: "test",
      policyName: "Test",
      rules: [
        {
          id: "r1",
          afterHoursMode: "allow_send",
          shortReplyMode: "allow",
          emojiMode: "allow",
          threadAffinity: "prefer_thread",
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "admin",
    };
    expect(policyHasHighRiskAutoSend(policy)).toBe(true);
  });

  test("detects no high risk", () => {
    const policy = defaultReplyPolicy();
    expect(policyHasHighRiskAutoSend(policy)).toBe(false);
  });
});

describe("evaluateReplyPolicy", () => {
  const businessHoursPolicy: OrgReplyPolicy = {
    version: 1,
    policyId: "test",
    policyName: "Test",
    rules: [
      {
        id: "r1",
        afterHoursMode: "draft_only",
        shortReplyMode: "warn",
        shortReplyMinChars: 20,
        emojiMode: "deny",
        threadAffinity: "prefer_thread",
        businessHours: {
          dayOfWeek: [1, 2, 3, 4, 5],
          startTime: "09:00",
          endTime: "18:00",
          timezone: "Asia/Tokyo",
        },
      },
    ],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin",
  };

  test("allows during business hours", () => {
    const tuesdayMorning = new Date("2026-09-08T10:00:00+09:00");
    const result = evaluateReplyPolicy({
      policy: businessHoursPolicy,
      surface: "slack",
      currentTime: tuesdayMorning,
      timezone: "Asia/Tokyo",
      messageText: "これは十分に長いメッセージです。テストのため。",
      channelId: "C123",
    });
    expect(result.allowed).toBe(true);
    expect(result.draftOnly).toBe(false);
    expect(result.holdApproval).toBe(false);
  });

  test("draft only after business hours", () => {
    const saturdayNight = new Date("2026-09-12T22:00:00+09:00");
    const result = evaluateReplyPolicy({
      policy: businessHoursPolicy,
      surface: "slack",
      currentTime: saturdayNight,
      timezone: "Asia/Tokyo",
      messageText: "Test message",
      channelId: "C123",
    });
    expect(result.draftOnly).toBe(true);
    expect(result.auditLabels).toContain("after_hours");
    expect(result.auditLabels).toContain("after_hours_draft_only");
  });

  test("hold approval after hours with hold_approval mode", () => {
    const holdPolicy: OrgReplyPolicy = {
      ...businessHoursPolicy,
      rules: [
        {
          ...businessHoursPolicy.rules[0],
          afterHoursMode: "hold_approval",
        },
      ],
    };
    const saturdayNight = new Date("2026-09-12T22:00:00+09:00");
    const result = evaluateReplyPolicy({
      policy: holdPolicy,
      surface: "slack",
      currentTime: saturdayNight,
      timezone: "Asia/Tokyo",
      messageText: "Test message",
      channelId: "C123",
    });
    expect(result.holdApproval).toBe(true);
    expect(result.holdReason).toBe("after_hours_requires_approval");
  });

  test("strips emojis when emojiMode is deny", () => {
    const tuesdayMorning = new Date("2026-09-08T10:00:00+09:00");
    const result = evaluateReplyPolicy({
      policy: businessHoursPolicy,
      surface: "slack",
      currentTime: tuesdayMorning,
      timezone: "Asia/Tokyo",
      messageText: "Hello 👋 World 🌍",
      channelId: "C123",
    });
    expect(result.emojiStripped).toBe(true);
    expect(result.auditLabels).toContain("emoji_stripped_all");
  });

  test("warns on short reply", () => {
    const tuesdayMorning = new Date("2026-09-08T10:00:00+09:00");
    const result = evaluateReplyPolicy({
      policy: businessHoursPolicy,
      surface: "slack",
      currentTime: tuesdayMorning,
      timezone: "Asia/Tokyo",
      messageText: "OK",
      channelId: "C123",
    });
    expect(result.shortReplyWarning).toBe(true);
    expect(result.auditLabels).toContain("short_reply_warning");
  });

  test("denies short reply when mode is deny", () => {
    const denyShortPolicy: OrgReplyPolicy = {
      ...businessHoursPolicy,
      rules: [
        {
          ...businessHoursPolicy.rules[0],
          shortReplyMode: "deny",
        },
      ],
    };
    const tuesdayMorning = new Date("2026-09-08T10:00:00+09:00");
    const result = evaluateReplyPolicy({
      policy: denyShortPolicy,
      surface: "slack",
      currentTime: tuesdayMorning,
      timezone: "Asia/Tokyo",
      messageText: "OK",
      channelId: "C123",
    });
    expect(result.holdApproval).toBe(true);
    expect(result.holdReason).toBe("short_reply_denied");
  });

  test("uses existing thread ts with prefer_thread", () => {
    const tuesdayMorning = new Date("2026-09-08T10:00:00+09:00");
    const result = evaluateReplyPolicy({
      policy: businessHoursPolicy,
      surface: "slack",
      currentTime: tuesdayMorning,
      timezone: "Asia/Tokyo",
      messageText: "This is a long enough message for testing.",
      channelId: "C123",
      existingThreadTs: "1234567890.123456",
    });
    expect(result.threadTs).toBe("1234567890.123456");
    expect(result.newThread).toBe(false);
  });

  test("creates new thread when topic changes", () => {
    const newThreadPolicy: OrgReplyPolicy = {
      ...businessHoursPolicy,
      rules: [
        {
          ...businessHoursPolicy.rules[0],
          threadAffinity: "new_thread_per_topic",
          topicChangeThreshold: 0.5,
        },
      ],
    };
    const tuesdayMorning = new Date("2026-09-08T10:00:00+09:00");
    const result = evaluateReplyPolicy({
      policy: newThreadPolicy,
      surface: "slack",
      currentTime: tuesdayMorning,
      timezone: "Asia/Tokyo",
      messageText: "This is a completely different topic.",
      channelId: "C123",
      parentThreadTs: "1234567890.123456",
      topicSimilarity: 0.2,
    });
    expect(result.newThread).toBe(true);
    expect(result.threadTs).toBeUndefined();
    expect(result.auditLabels).toContain("thread_new_topic");
  });
});

describe("applyEmojiPolicy", () => {
  const denyRule: ReplyPolicyRule = {
    id: "test",
    afterHoursMode: "draft_only",
    shortReplyMode: "allow",
    emojiMode: "deny",
    threadAffinity: "prefer_thread",
  };

  const limitedRule: ReplyPolicyRule = {
    id: "test",
    afterHoursMode: "draft_only",
    shortReplyMode: "allow",
    emojiMode: "limited",
    allowedEmojis: ["👍", "✅"],
    threadAffinity: "prefer_thread",
  };

  const allowRule: ReplyPolicyRule = {
    id: "test",
    afterHoursMode: "draft_only",
    shortReplyMode: "allow",
    emojiMode: "allow",
    threadAffinity: "prefer_thread",
  };

  test("strips all emojis when emojiMode is deny", () => {
    const result = applyEmojiPolicy("Hello 👋 World 🌍", denyRule);
    expect(result.text).toBe("Hello  World");
    expect(result.stripped).toBe(true);
  });

  test("allows only specified emojis when emojiMode is limited", () => {
    const result = applyEmojiPolicy("Good 👍 Bad 👎 Done ✅", limitedRule);
    expect(result.text).toBe("Good 👍 Bad  Done ✅");
    expect(result.stripped).toBe(true);
  });

  test("keeps all emojis when emojiMode is allow", () => {
    const result = applyEmojiPolicy("Hello 👋 World 🌍", allowRule);
    expect(result.text).toBe("Hello 👋 World 🌍");
    expect(result.stripped).toBe(false);
  });
});

describe("shouldDraftOnly / shouldHoldForApproval", () => {
  test("shouldDraftOnly returns true for draft only decisions", () => {
    expect(
      shouldDraftOnly({
        allowed: true,
        draftOnly: true,
        holdApproval: false,
        emojiStripped: false,
        shortReplyWarning: false,
        newThread: false,
        auditLabels: [],
        appliedRules: [],
      })
    ).toBe(true);
  });

  test("shouldHoldForApproval returns true for hold decisions", () => {
    expect(
      shouldHoldForApproval({
        allowed: false,
        draftOnly: false,
        holdApproval: true,
        holdReason: "test",
        emojiStripped: false,
        shortReplyWarning: false,
        newThread: false,
        auditLabels: [],
        appliedRules: [],
      })
    ).toBe(true);
  });
});

describe("summarizeReplyPolicyDecision", () => {
  test("summarizes draft only decision", () => {
    const summary = summarizeReplyPolicyDecision({
      allowed: true,
      draftOnly: true,
      holdApproval: false,
      emojiStripped: false,
      shortReplyWarning: false,
      newThread: false,
      auditLabels: [],
      appliedRules: [],
    });
    expect(summary).toContain("draft_only");
  });

  test("summarizes hold decision", () => {
    const summary = summarizeReplyPolicyDecision({
      allowed: false,
      draftOnly: false,
      holdApproval: true,
      holdReason: "test_reason",
      emojiStripped: false,
      shortReplyWarning: false,
      newThread: false,
      auditLabels: [],
      appliedRules: [],
    });
    expect(summary).toContain("hold:test_reason");
  });

  test("summarizes complex decision", () => {
    const summary = summarizeReplyPolicyDecision({
      allowed: true,
      draftOnly: false,
      holdApproval: false,
      emojiStripped: true,
      shortReplyWarning: true,
      newThread: true,
      auditLabels: [],
      appliedRules: [],
    });
    expect(summary).toContain("emoji_stripped");
    expect(summary).toContain("short_warning");
    expect(summary).toContain("new_thread");
  });
});

describe("isAfterBusinessHours", () => {
  const policy: OrgReplyPolicy = {
    version: 1,
    policyId: "test",
    policyName: "Test",
    rules: [
      {
        id: "r1",
        afterHoursMode: "draft_only",
        shortReplyMode: "allow",
        emojiMode: "allow",
        threadAffinity: "prefer_thread",
        businessHours: {
          dayOfWeek: [1, 2, 3, 4, 5],
          startTime: "09:00",
          endTime: "18:00",
          timezone: "Asia/Tokyo",
        },
      },
    ],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin",
  };

  test("returns false during business hours", () => {
    const tuesdayMorning = new Date("2026-09-08T10:00:00+09:00");
    expect(isAfterBusinessHours(tuesdayMorning, policy, "slack", "Asia/Tokyo")).toBe(false);
  });

  test("returns true after business hours", () => {
    const tuesdayNight = new Date("2026-09-08T20:00:00+09:00");
    expect(isAfterBusinessHours(tuesdayNight, policy, "slack", "Asia/Tokyo")).toBe(true);
  });

  test("returns true on weekend", () => {
    const saturday = new Date("2026-09-12T10:00:00+09:00");
    expect(isAfterBusinessHours(saturday, policy, "slack", "Asia/Tokyo")).toBe(true);
  });
});

describe("summarizeReplyPolicyJa / nextStepReplyPolicyJa", () => {
  test("summarizes default policy", () => {
    const policy = defaultReplyPolicy();
    const summary = summarizeReplyPolicyJa(policy);
    expect(summary).toContain("デフォルト");
  });

  test("summarizes custom policy", () => {
    const policy: OrgReplyPolicy = {
      version: 1,
      policyId: "custom",
      policyName: "Custom",
      rules: [
        {
          id: "r1",
          surface: "slack",
          afterHoursMode: "allow_send",
          shortReplyMode: "deny",
          emojiMode: "deny",
          threadAffinity: "channel_root",
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "admin",
    };
    const summary = summarizeReplyPolicyJa(policy);
    expect(summary).toContain("slack:");
    expect(summary).toContain("時間外も送信");
    expect(summary).toContain("絵文字禁止");
    expect(summary).toContain("チャネル直接");
  });

  test("next step for default policy", () => {
    const policy = defaultReplyPolicy();
    const nextStep = nextStepReplyPolicyJa(policy);
    expect(nextStep).toContain("デフォルト");
  });

  test("next step warns about high risk without consent", () => {
    const policy: OrgReplyPolicy = {
      version: 1,
      policyId: "risky",
      policyName: "Risky",
      rules: [
        {
          id: "r1",
          afterHoursMode: "allow_send",
          shortReplyMode: "allow",
          emojiMode: "allow",
          threadAffinity: "prefer_thread",
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "admin",
    };
    const nextStep = nextStepReplyPolicyJa(policy);
    expect(nextStep).toContain("テナント承諾が未記録");
  });
});
