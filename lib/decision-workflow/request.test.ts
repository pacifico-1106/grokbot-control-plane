/**
 * P1 Decision Workflow — Request Tests
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import {
  calculateFiscalYear,
  calculateTaxExcludedAmount,
  containsT3Keywords,
  determineDecisionTier,
  validateDecisionRequest,
} from "./request";
import type { DecisionWorkflowConfig } from "@/lib/approval-kind-routes/types";
import type { DecisionRequestInput } from "./types";

mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => null,
}));

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
}));

const defaultConfig: DecisionWorkflowConfig = {
  amountThresholdJpy: 500000,
  fiscalYearStartMonth: 4,
  fiscalYearStartDay: 1,
  tiers: [
    {
      tier: "T1",
      nameJa: "専決",
      approverUserIds: ["owner-1"],
      quorum: { type: "any" },
      onExpire: "keep_open",
      remindEveryDays: 3,
    },
    {
      tier: "T2",
      nameJa: "理事過半数",
      approverUserIds: ["owner-1", "admin-1", "admin-2"],
      quorum: { type: "count", n: 2 },
      deadlineHours: 72,
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
    {
      tier: "T3",
      nameJa: "社員総会",
      approverUserIds: ["owner-1", "admin-1", "admin-2", "member-1"],
      quorum: { type: "all" },
      onExpire: "keep_open",
      remindEveryDays: 1,
    },
  ],
};

describe("calculateTaxExcludedAmount", () => {
  test("calculates tax-excluded from tax-included", () => {
    expect(calculateTaxExcludedAmount(110000, true)).toBe(99999);
    expect(calculateTaxExcludedAmount(550000, true)).toBe(499999);
    expect(calculateTaxExcludedAmount(1100000, true)).toBe(999999);
  });

  test("returns same amount when not tax-included", () => {
    expect(calculateTaxExcludedAmount(100000, false)).toBe(100000);
    expect(calculateTaxExcludedAmount(500000, false)).toBe(500000);
  });

  test("floors the result", () => {
    expect(calculateTaxExcludedAmount(111, true)).toBe(100);
  });
});

describe("calculateFiscalYear", () => {
  test("calculates fiscal year starting April", () => {
    const config: DecisionWorkflowConfig = {
      ...defaultConfig,
      fiscalYearStartMonth: 4,
      fiscalYearStartDay: 1,
    };

    const apr2024 = new Date("2024-04-01");
    const result = calculateFiscalYear(apr2024, config);
    expect(result.fiscalYear).toBe("FY2024");

    const mar2024 = new Date("2024-03-31");
    const result2 = calculateFiscalYear(mar2024, config);
    expect(result2.fiscalYear).toBe("FY2023");
  });

  test("calculates fiscal year starting January", () => {
    const config: DecisionWorkflowConfig = {
      ...defaultConfig,
      fiscalYearStartMonth: 1,
      fiscalYearStartDay: 1,
    };

    const jan2024 = new Date("2024-01-01");
    const result = calculateFiscalYear(jan2024, config);
    expect(result.fiscalYear).toBe("FY2024");

    const dec2023 = new Date("2023-12-31");
    const result2 = calculateFiscalYear(dec2023, config);
    expect(result2.fiscalYear).toBe("FY2023");
  });
});

describe("containsT3Keywords", () => {
  test("detects 定款変更", () => {
    expect(containsT3Keywords("定款変更について")).toBe(true);
  });

  test("detects 役員", () => {
    expect(containsT3Keywords("新役員選任")).toBe(true);
  });

  test("detects 決算", () => {
    expect(containsT3Keywords("決算報告")).toBe(true);
  });

  test("detects 解散", () => {
    expect(containsT3Keywords("会社解散")).toBe(true);
  });

  test("returns false for non-matching text", () => {
    expect(containsT3Keywords("通常の経費申請")).toBe(false);
    expect(containsT3Keywords("備品購入")).toBe(false);
  });
});

describe("determineDecisionTier", () => {
  test("defaults to T1 for small amounts", () => {
    const input: DecisionRequestInput = {
      title: "経費申請",
      description: "出張経費",
      purpose: "顧客訪問",
      jobId: "job-1",
      amountJpy: 50000,
      taxIncluded: true,
    };

    const result = determineDecisionTier(input, defaultConfig);
    expect(result.tier).toBe("T1");
    expect(result.reason).toBe("T1_DEFAULT");
  });

  test("escalates to T2 for amounts >= threshold (tax-excluded)", () => {
    const input: DecisionRequestInput = {
      title: "大型契約",
      description: "サーバー購入",
      purpose: "インフラ更新",
      jobId: "job-1",
      amountJpy: 550001,
      taxIncluded: true,
    };

    const result = determineDecisionTier(input, defaultConfig);
    expect(result.tier).toBe("T2");
    expect(result.reason).toContain("T2_AMOUNT_THRESHOLD");
  });

  test("does not escalate to T2 when tax-excluded is below threshold", () => {
    const input: DecisionRequestInput = {
      title: "経費",
      description: "備品",
      purpose: "オフィス",
      jobId: "job-1",
      amountJpy: 549999,
      taxIncluded: true,
    };

    const result = determineDecisionTier(input, defaultConfig);
    expect(result.tier).toBe("T1");
  });

  test("escalates to T3 for keyword match", () => {
    const input: DecisionRequestInput = {
      title: "定款変更の件",
      description: "事業目的追加",
      purpose: "事業拡大",
      jobId: "job-1",
      amountJpy: 10000,
    };

    const result = determineDecisionTier(input, defaultConfig);
    expect(result.tier).toBe("T3");
    expect(result.reason).toBe("T3_KEYWORD_MATCH (legacy)");
  });

  test("T3 keyword takes precedence over T2 amount", () => {
    const input: DecisionRequestInput = {
      title: "役員報酬変更",
      description: "役員報酬増額",
      purpose: "人事",
      jobId: "job-1",
      amountJpy: 1000000,
      taxIncluded: true,
    };

    const result = determineDecisionTier(input, defaultConfig);
    expect(result.tier).toBe("T3");
    expect(result.reason).toBe("T3_KEYWORD_MATCH (legacy)");
  });

  test("allows upgrade via requestedTier", () => {
    const input: DecisionRequestInput = {
      title: "重要案件",
      description: "要検討事項",
      purpose: "リスク管理",
      jobId: "job-1",
      amountJpy: 10000,
      requestedTier: "T2",
    };

    const result = determineDecisionTier(input, defaultConfig);
    expect(result.tier).toBe("T2");
    expect(result.reason).toBe("REQUESTED_UPGRADE_TO_T2");
  });

  test("owner can downgrade tier", () => {
    const input: DecisionRequestInput = {
      title: "軽微案件",
      description: "高額だが専決可能",
      purpose: "迅速対応",
      jobId: "job-1",
      amountJpy: 600000,
      taxIncluded: true,
      requestedTier: "T1",
    };

    const result = determineDecisionTier(input, defaultConfig, true);
    expect(result.tier).toBe("T1");
    expect(result.reason).toBe("OWNER_DOWNGRADE_TO_T1");
  });

  test("non-owner cannot downgrade tier", () => {
    const input: DecisionRequestInput = {
      title: "軽微案件",
      description: "高額だが専決希望",
      purpose: "迅速対応",
      jobId: "job-1",
      amountJpy: 600000,
      taxIncluded: true,
      requestedTier: "T1",
    };

    const result = determineDecisionTier(input, defaultConfig, false);
    expect(result.tier).toBe("T2");
    expect(result.reason).toContain("T2_AMOUNT_THRESHOLD");
  });
});

describe("validateDecisionRequest", () => {
  test("accepts valid input", () => {
    const input: DecisionRequestInput = {
      title: "経費申請",
      description: "出張経費",
      purpose: "顧客訪問",
      jobId: "job-1",
      amountJpy: 50000,
    };

    const result = validateDecisionRequest(input, defaultConfig);
    expect(result.ok).toBe(true);
    expect(result.resolvedTier).toBe("T1");
    expect(result.fiscalYear).toBeDefined();
  });

  test("rejects missing title", () => {
    const input: DecisionRequestInput = {
      title: "",
      description: "出張経費",
      purpose: "顧客訪問",
      jobId: "job-1",
    };

    const result = validateDecisionRequest(input, defaultConfig);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("title_required");
  });

  test("rejects missing description", () => {
    const input: DecisionRequestInput = {
      title: "経費申請",
      description: "",
      purpose: "顧客訪問",
      jobId: "job-1",
    };

    const result = validateDecisionRequest(input, defaultConfig);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("description_required");
  });

  test("rejects missing purpose", () => {
    const input: DecisionRequestInput = {
      title: "経費申請",
      description: "出張経費",
      purpose: "",
      jobId: "job-1",
    };

    const result = validateDecisionRequest(input, defaultConfig);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("purpose_required");
  });

  test("rejects missing jobId", () => {
    const input: DecisionRequestInput = {
      title: "経費申請",
      description: "出張経費",
      purpose: "顧客訪問",
      jobId: "",
    };

    const result = validateDecisionRequest(input, defaultConfig);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("jobId_required");
  });

  test("rejects negative amountJpy", () => {
    const input: DecisionRequestInput = {
      title: "経費申請",
      description: "出張経費",
      purpose: "顧客訪問",
      jobId: "job-1",
      amountJpy: -1000,
    };

    const result = validateDecisionRequest(input, defaultConfig);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("amountJpy_negative");
  });

  test("calculates tax-excluded amount", () => {
    const input: DecisionRequestInput = {
      title: "経費申請",
      description: "出張経費",
      purpose: "顧客訪問",
      jobId: "job-1",
      amountJpy: 110000,
      taxIncluded: true,
    };

    const result = validateDecisionRequest(input, defaultConfig);
    expect(result.ok).toBe(true);
    expect(result.taxExcludedAmountJpy).toBe(99999);
  });
});
