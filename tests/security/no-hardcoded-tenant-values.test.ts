/**
 * Security Test: No Hardcoded Tenant Values
 *
 * This test ensures that logic modules do not contain hardcoded tenant-specific
 * values. All tenant-specific configuration (like みらい社中 values) must be
 * stored in preset files or org config, not in logic code.
 *
 * Allowed locations for tenant values:
 * - lib/approval-kind-routes/presets/mirai-shachu.ts (preset file)
 * - Database/config (org-level policy JSON)
 *
 * Forbidden locations:
 * - lib/decision-workflow/*.ts (except types.ts for deprecated exports)
 * - lib/approval-kind-routes/*.ts (except presets/ and validate.ts re-exports)
 * - lib/data/*.ts
 * - lib/stuck-watch/*.ts
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const WORKSPACE_ROOT = path.resolve(__dirname, "../..");

/**
 * みらい社中 specific values that should NOT appear in logic modules.
 * These values are allowed ONLY in preset files.
 */
const MIRAI_SHACHU_VALUES = {
  amount_threshold: "500000", // ¥500,000 threshold (tax-excluded)
  t2_deadline: "72", // T2 72h deadline (as hours)
  remind_days: "3", // 3-day reminders - BUT this is also a sensible default
  fiscal_month: "4", // April (FY start month) - BUT this is Japan standard
  fiscal_day: "1", // 1st (FY start day) - BUT this is standard
  t3_keywords: [
    "定款変更",
    "役員",
    "決算",
    "解散",
    "合併",
    "分割",
    "資本金",
    "重要財産",
  ],
  sensitive_topics: [
    "決算",
    "役員",
    "定款",
    "人事",
    "給与",
    "個人情報",
    "法務",
    "訴訟",
    "契約",
    "NDA",
    "秘密保持",
  ],
};

/**
 * Logic modules that should NOT contain hardcoded tenant values.
 * Preset files and type-only files are excluded.
 *
 * Note: Some modules still use deprecated exports from types.ts.
 * This will be cleaned up in PR2 when T3 keywords move to config.
 */
const LOGIC_MODULE_PATHS = [
  "lib/decision-workflow/progress.ts",
  "lib/decision-workflow/result.ts",
  "lib/decision-workflow/voting-card.ts",
  "lib/decision-workflow/notify.ts",
  "lib/decision-workflow/deputy.ts",
  "lib/approval-kind-routes/engine.ts",
  "lib/approval-kind-routes/data.ts",
  "lib/approval-kind-routes/workflow-bridge.ts",
  "lib/approval-kind-routes/mcp-handlers.ts",
  "lib/data/approvals.ts",
  "lib/stuck-watch/items.ts",
];

/**
 * Files that are ALLOWED to contain tenant values.
 * - Preset files contain reference values
 * - types.ts contains deprecated exports for backward compatibility
 * - validate.ts re-exports from presets
 * - topic-gate.ts re-exports from presets
 * - request.ts still uses T3_AUTO_ESCALATION_KEYWORDS (to be moved in PR2)
 * - expiry.ts has LEGACY_T2_DEADLINE_HOURS for backward compatibility
 * - engine.ts has t3Classifications (to be moved in PR2)
 */
const ALLOWED_FILES = [
  "lib/approval-kind-routes/presets/mirai-shachu.ts",
  "lib/approval-kind-routes/presets/defaults.ts",
  "lib/approval-kind-routes/presets/index.ts",
  "lib/decision-workflow/types.ts", // deprecated exports
  "lib/approval-kind-routes/validate.ts", // re-exports from presets
  "lib/decision-workflow/topic-gate.ts", // re-exports from presets
  "lib/decision-workflow/request.ts", // uses T3_AUTO_ESCALATION_KEYWORDS (to be moved in PR2)
  "lib/decision-workflow/expiry.ts", // has LEGACY_T2_DEADLINE_HOURS for backward compat
  "lib/approval-kind-routes/engine.ts", // has t3Classifications (to be moved in PR2)
];

function readFile(relativePath: string): string {
  const fullPath = path.join(WORKSPACE_ROOT, relativePath);
  if (!fs.existsSync(fullPath)) {
    return "";
  }
  return fs.readFileSync(fullPath, "utf-8");
}

function isAllowedFile(relativePath: string): boolean {
  return ALLOWED_FILES.some((allowed) => relativePath.endsWith(allowed));
}

describe("No Hardcoded Tenant Values", () => {
  describe("T3 Keywords", () => {
    test("should not have T3 keywords hardcoded in logic modules", () => {
      for (const modulePath of LOGIC_MODULE_PATHS) {
        if (isAllowedFile(modulePath)) continue;

        const content = readFile(modulePath);
        if (!content) continue;

        for (const keyword of MIRAI_SHACHU_VALUES.t3_keywords) {
          const hasKeyword =
            content.includes(`"${keyword}"`) || content.includes(`'${keyword}'`);

          expect(hasKeyword).toBe(false);
        }
      }
    });
  });

  describe("Sensitive Topics", () => {
    test("should not have sensitive topics hardcoded in logic modules", () => {
      for (const modulePath of LOGIC_MODULE_PATHS) {
        if (isAllowedFile(modulePath)) continue;

        const content = readFile(modulePath);
        if (!content) continue;

        for (const topic of MIRAI_SHACHU_VALUES.sensitive_topics) {
          const hasTopic =
            content.includes(`"${topic}"`) || content.includes(`'${topic}'`);

          expect(hasTopic).toBe(false);
        }
      }
    });
  });

  describe("Amount Threshold", () => {
    test("should not have 500000 threshold hardcoded in logic modules (except as default)", () => {
      for (const modulePath of LOGIC_MODULE_PATHS) {
        if (isAllowedFile(modulePath)) continue;

        const content = readFile(modulePath);
        if (!content) continue;

        // Check for hardcoded 500000 that's NOT a default reference
        // Pattern: matches 500000 but not DEFAULT_AMOUNT_THRESHOLD_JPY
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes("500000") && !line.includes("DEFAULT_") && !line.includes("config")) {
            // Allow fallback expressions like "config?.amountThresholdJpy ?? 500000"
            if (line.includes("??") || line.includes("||")) continue;
            // Allow comments
            if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

            expect(line).not.toContain("500000");
          }
        }
      }
    });
  });

  describe("Deadline Hours", () => {
    test("should not have T2_DEADLINE_HOURS = 72 in logic modules", () => {
      for (const modulePath of LOGIC_MODULE_PATHS) {
        if (isAllowedFile(modulePath)) continue;

        const content = readFile(modulePath);
        if (!content) continue;

        // Check for T2_DEADLINE_HOURS constant definition (not usage)
        const hasHardcodedConstant =
          content.includes("T2_DEADLINE_HOURS = 72") ||
          content.includes("T2_DEADLINE_HOURS=72");

        expect(hasHardcodedConstant).toBe(false);
      }
    });
  });

  describe("Preset Files Exist", () => {
    test("should have mirai-shachu preset file", () => {
      const content = readFile("lib/approval-kind-routes/presets/mirai-shachu.ts");
      expect(content.length).toBeGreaterThan(0);

      // Should contain the tenant-specific values
      for (const keyword of MIRAI_SHACHU_VALUES.t3_keywords.slice(0, 3)) {
        expect(content).toContain(keyword);
      }
    });

    test("should have neutral defaults preset file", () => {
      const content = readFile("lib/approval-kind-routes/presets/defaults.ts");
      expect(content.length).toBeGreaterThan(0);

      // Should contain default constants
      expect(content).toContain("DEFAULT_CONSUMPTION_TAX_RATE");
      expect(content).toContain("DEFAULT_AMOUNT_THRESHOLD_JPY");
    });
  });

  describe("Config-Based Behavior", () => {
    test("request.ts should get tax rate from config", () => {
      const content = readFile("lib/decision-workflow/request.ts");
      expect(content).toContain("config?.consumptionTaxRate");
      expect(content).toContain("DEFAULT_CONSUMPTION_TAX_RATE");
    });

    test("request.ts should get deadline from tier route", () => {
      const content = readFile("lib/decision-workflow/request.ts");
      expect(content).toContain("tierRoute?.deadlineHours");
      // Should NOT have hardcoded T2 deadline logic (tier === "T2" ? T2_DEADLINE_HOURS : ...)
      // Note: tier === "T2" may appear in comments or risk level logic, that's fine
      expect(content).not.toContain("T2_DEADLINE_HOURS");
    });

    test("expiry.ts should check onExpire from tier config", () => {
      const content = readFile("lib/decision-workflow/expiry.ts");
      expect(content).toContain("getOnExpireBehavior");
      expect(content).toContain("tierRoute.onExpire");
    });

    test("topic-gate.ts should not fallback to DEFAULT_SENSITIVE_TOPICS", () => {
      const content = readFile("lib/decision-workflow/topic-gate.ts");
      // Should NOT have: config.sensitiveTopics.length > 0 ? ... : DEFAULT_SENSITIVE_TOPICS
      expect(content).not.toContain("sensitiveTopics.length > 0");
    });
  });
});
