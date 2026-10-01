/**
 * P1 Decision Workflow — Topic Gate Tests
 */

import { describe, expect, test, mock } from "bun:test";
import {
  checkTopicGate,
  containsSensitiveTopic,
  createDefaultTopicGateConfig,
  DEFAULT_SENSITIVE_TOPICS,
  formatTopicGateCard,
  isMainBoardChannel,
  validateTopicGateConfig,
} from "./topic-gate";
import type { TopicGateConfig } from "@/lib/approval-kind-routes/types";

mock.module("@/lib/feature-flags", () => ({
  isTopicGatedPostingEnabled: () => true,
}));

const enabledConfig: TopicGateConfig = {
  enabled: true,
  sensitiveTopics: ["決算", "役員", "人事", "給与"],
  mainBoardChannelIds: ["C01MAINBOARD"],
};

describe("containsSensitiveTopic", () => {
  test("detects single topic", () => {
    const matched = containsSensitiveTopic("今期の決算報告です", enabledConfig.sensitiveTopics);
    expect(matched).toContain("決算");
  });

  test("detects multiple topics", () => {
    const matched = containsSensitiveTopic("役員の給与について", enabledConfig.sensitiveTopics);
    expect(matched).toContain("役員");
    expect(matched).toContain("給与");
  });

  test("case insensitive matching", () => {
    const matched = containsSensitiveTopic("JINNJI関連の話", ["人事"]);
    expect(matched.length).toBe(0);

    const matched2 = containsSensitiveTopic("人事関連の話", ["人事"]);
    expect(matched2).toContain("人事");
  });

  test("returns empty for no match", () => {
    const matched = containsSensitiveTopic("通常の経費報告です", enabledConfig.sensitiveTopics);
    expect(matched.length).toBe(0);
  });
});

describe("isMainBoardChannel", () => {
  test("returns true for main board channel", () => {
    expect(isMainBoardChannel("C01MAINBOARD", ["C01MAINBOARD"])).toBe(true);
  });

  test("returns false for non-main board channel", () => {
    expect(isMainBoardChannel("C02OTHER", ["C01MAINBOARD"])).toBe(false);
  });

  test("returns false for empty config", () => {
    expect(isMainBoardChannel("C01MAINBOARD", [])).toBe(false);
  });
});

describe("checkTopicGate", () => {
  test("allows post with no sensitive topics", () => {
    const result = checkTopicGate("通常の報告です", "C01GENERAL", enabledConfig);

    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.matchedTopics.length).toBe(0);
    expect(result.reason).toBe("no_sensitive_topic");
  });

  test("requires approval for sensitive topic", () => {
    const result = checkTopicGate("決算報告の件", "C01GENERAL", enabledConfig);

    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.matchedTopics).toContain("決算");
    expect(result.reason).toBe("sensitive_topic_requires_approval");
  });

  test("requires approval for main board sensitive topic", () => {
    const result = checkTopicGate("役員会の議題", "C01MAINBOARD", enabledConfig);

    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.reason).toBe("main_board_sensitive_topic");
  });

  test("allows when config is disabled", () => {
    const disabledConfig: TopicGateConfig = {
      ...enabledConfig,
      enabled: false,
    };

    const result = checkTopicGate("決算報告", "C01GENERAL", disabledConfig);

    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.reason).toBe("topic_gate_not_configured");
  });

  test("allows all when sensitiveTopics is empty (explicit opt-out)", () => {
    // An explicit empty array means "no sensitive topics" - NOT fallback to defaults
    const configWithoutTopics: TopicGateConfig = {
      enabled: true,
      sensitiveTopics: [],
      mainBoardChannelIds: [],
    };

    const result = checkTopicGate("決算報告", "C01GENERAL", configWithoutTopics);

    // Empty sensitiveTopics = no topics to check = everything allowed
    expect(result.requiresApproval).toBe(false);
    expect(result.allowed).toBe(true);
    expect(result.matchedTopics).toEqual([]);
  });

  test("allows when config is null", () => {
    const result = checkTopicGate("決算報告", "C01GENERAL", null);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("topic_gate_not_configured");
  });
});

describe("formatTopicGateCard", () => {
  test("formats card with channel and topics", () => {
    const card = formatTopicGateCard(
      "決算報告の件です。今期の業績について...",
      ["決算"],
      "C01GENERAL"
    );

    expect(card.title).toBe("機密話題を含む投稿の承認依頼");
    expect(card.summary).toContain("チャネル: C01GENERAL");
    expect(card.summary).toContain("検出された話題: 決算");
    expect(card.risk).toBe("high");
  });

  test("formats card without channel", () => {
    const card = formatTopicGateCard("役員人事の話", ["役員", "人事"], null);

    expect(card.summary).not.toContain("チャネル:");
    expect(card.summary).toContain("検出された話題: 役員, 人事");
  });

  test("truncates long content", () => {
    const longContent = "決算報告".repeat(100);
    const card = formatTopicGateCard(longContent, ["決算"], "C01");

    expect(card.summary.length).toBeLessThan(500);
    expect(card.summary).toContain("...");
  });
});

describe("validateTopicGateConfig", () => {
  test("accepts valid config", () => {
    const result = validateTopicGateConfig({
      enabled: true,
      sensitiveTopics: ["決算", "役員"],
      mainBoardChannelIds: ["C01"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.enabled).toBe(true);
      expect(result.config.sensitiveTopics).toContain("決算");
    }
  });

  test("rejects null config", () => {
    const result = validateTopicGateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("config_required");
    }
  });

  test("rejects non-boolean enabled", () => {
    const result = validateTopicGateConfig({
      enabled: "true",
      sensitiveTopics: [],
      mainBoardChannelIds: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("enabled_must_be_boolean");
    }
  });

  test("rejects non-array sensitiveTopics", () => {
    const result = validateTopicGateConfig({
      enabled: true,
      sensitiveTopics: "決算",
      mainBoardChannelIds: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("sensitiveTopics_must_be_array");
    }
  });

  test("rejects empty string in sensitiveTopics", () => {
    const result = validateTopicGateConfig({
      enabled: true,
      sensitiveTopics: ["決算", ""],
      mainBoardChannelIds: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("sensitiveTopics"))).toBe(true);
    }
  });

  test("trims sensitive topics", () => {
    const result = validateTopicGateConfig({
      enabled: true,
      sensitiveTopics: [" 決算 ", "役員"],
      mainBoardChannelIds: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.sensitiveTopics[0]).toBe("決算");
    }
  });
});

describe("createDefaultTopicGateConfig", () => {
  test("creates disabled config with default topics", () => {
    const config = createDefaultTopicGateConfig();

    expect(config.enabled).toBe(false);
    expect(config.sensitiveTopics.length).toBeGreaterThan(0);
    expect(config.mainBoardChannelIds.length).toBe(0);
  });

  test("includes all default sensitive topics", () => {
    const config = createDefaultTopicGateConfig();

    for (const topic of DEFAULT_SENSITIVE_TOPICS) {
      expect(config.sensitiveTopics).toContain(topic);
    }
  });
});

describe("DEFAULT_SENSITIVE_TOPICS", () => {
  test("includes generic financial and legal topics", () => {
    // DEFAULT_SENSITIVE_TOPICS now comes from presets/defaults.ts
    // and contains generic (not tenant-specific) topics
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("金額");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("決算");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("個人情報");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("定款");
    // These are generic defaults, not みらい社中 specific
    expect(DEFAULT_SENSITIVE_TOPICS.length).toBeGreaterThan(5);
  });
});
