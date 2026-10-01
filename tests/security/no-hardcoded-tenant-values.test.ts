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
 * - lib/decision-workflow/*.ts (except types.ts for notes)
 * - lib/approval-kind-routes/*.ts (except presets/)
 * - lib/data/*.ts
 * - lib/stuck-watch/*.ts
 *
 * STRICT ENFORCEMENT:
 * - No hardcoded T3 keywords (定款変更, 役員, 決算, etc.) in logic
 * - No hardcoded amount thresholds (500000) in logic
 * - No hardcoded tax rates (0.1 or 0.10) in logic except DEFAULT_CONSUMPTION_TAX_RATE
 * - No T3_AUTO_ESCALATION_KEYWORDS or CONSUMPTION_TAX_RATE exports from types.ts
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const WORKSPACE_ROOT = path.resolve(__dirname, "../..");

/**
 * みらい社中 specific values that should NOT appear in logic modules.
 * These values are allowed ONLY in preset files.
 */
const MIRAI_SHACHU_T3_KEYWORDS = [
  "定款変更",
  "役員",
  "決算",
  "解散",
  "合併",
  "分割",
  "資本金",
  "重要財産",
];

/**
 * Logic modules that should NOT contain hardcoded tenant values.
 * Includes request.ts and engine.ts - these must NOT have hardcoded keywords/amounts.
 */
const LOGIC_MODULE_PATHS = [
  "lib/decision-workflow/request.ts",
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
 * - validate.ts may reference constants from presets
 * - topic-gate.ts re-exports from presets
 * - expiry.ts has LEGACY_T2_DEADLINE_HOURS for backward compat with existing T2 records
 */
const ALLOWED_FILES = [
  "lib/approval-kind-routes/presets/mirai-shachu.ts",
  "lib/approval-kind-routes/presets/defaults.ts",
  "lib/approval-kind-routes/presets/index.ts",
  "lib/approval-kind-routes/validate.ts", // may import from presets
  "lib/decision-workflow/topic-gate.ts", // re-exports from presets
  "lib/decision-workflow/expiry.ts", // LEGACY_T2_DEADLINE_HOURS for existing records
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

function getFileLines(content: string): string[] {
  return content.split("\n");
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

describe("No Hardcoded Tenant Values", () => {
  describe("T3 Keywords", () => {
    test("should not have T3 keywords hardcoded in logic modules", () => {
      for (const modulePath of LOGIC_MODULE_PATHS) {
        if (isAllowedFile(modulePath)) continue;

        const content = readFile(modulePath);
        if (!content) continue;

        const lines = getFileLines(content);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;

          for (const keyword of MIRAI_SHACHU_T3_KEYWORDS) {
            const hasKeyword =
              line.includes(`"${keyword}"`) || line.includes(`'${keyword}'`);

            expect(hasKeyword).toBe(false);
          }
        }
      }
    });

    test("types.ts should NOT export T3_AUTO_ESCALATION_KEYWORDS", () => {
      const content = readFile("lib/decision-workflow/types.ts");
      // Should not have an export of this constant (it's been removed)
      expect(content).not.toMatch(/export\s+(const|let|var)\s+T3_AUTO_ESCALATION_KEYWORDS/);
    });

    test("engine.ts should NOT have hardcoded t3Classifications", () => {
      const content = readFile("lib/approval-kind-routes/engine.ts");
      const lines = getFileLines(content);
      for (const line of lines) {
        if (isCommentLine(line)) continue;
        // Should not have t3Classifications array with keywords
        if (line.includes("t3Classifications") && !line.includes("@deprecated")) {
          expect(line).not.toMatch(/\[.*".*".*\]/);
        }
      }
    });
  });

  describe("Amount Threshold", () => {
    test("should not have hardcoded 500000 in logic modules", () => {
      for (const modulePath of LOGIC_MODULE_PATHS) {
        if (isAllowedFile(modulePath)) continue;

        const content = readFile(modulePath);
        if (!content) continue;

        const lines = getFileLines(content);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;

          // 500000 should not appear in logic, even as a fallback
          if (line.includes("500000")) {
            // Fail - this value should come from config, not be hardcoded
            expect(line).not.toContain("500000");
          }
        }
      }
    });

    test("defaults.ts should NOT have DEFAULT_AMOUNT_THRESHOLD_JPY", () => {
      const content = readFile("lib/approval-kind-routes/presets/defaults.ts");
      // Amount thresholds are tenant policy, not neutral defaults
      expect(content).not.toMatch(/export\s+(const|let|var)\s+DEFAULT_AMOUNT_THRESHOLD_JPY\s*=/);
    });
  });

  describe("Tax Rate", () => {
    test("types.ts should NOT export CONSUMPTION_TAX_RATE", () => {
      const content = readFile("lib/decision-workflow/types.ts");
      // Should not have an export of this constant (it's been removed)
      expect(content).not.toMatch(/export\s+(const|let|var)\s+CONSUMPTION_TAX_RATE\s*=/);
    });

    test("should not have hardcoded 0.1 or 0.10 tax rate in logic (except DEFAULT_)", () => {
      for (const modulePath of LOGIC_MODULE_PATHS) {
        if (isAllowedFile(modulePath)) continue;

        const content = readFile(modulePath);
        if (!content) continue;

        const lines = getFileLines(content);
        for (const line of lines) {
          if (isCommentLine(line)) continue;

          // Check for = 0.1 or = 0.10 but not DEFAULT_CONSUMPTION_TAX_RATE
          if ((line.includes("= 0.1") || line.includes("= 0.10")) && 
              !line.includes("DEFAULT_CONSUMPTION_TAX_RATE")) {
            expect(line).not.toMatch(/=\s*0\.1(0)?\s*;?$/);
          }
        }
      }
    });
  });

  describe("Deadline Hours", () => {
    test("should not have T2_DEADLINE_HOURS in logic modules (except expiry.ts LEGACY_)", () => {
      for (const modulePath of LOGIC_MODULE_PATHS) {
        if (isAllowedFile(modulePath)) continue;

        const content = readFile(modulePath);
        if (!content) continue;

        // Check for T2_DEADLINE_HOURS (not LEGACY_T2_DEADLINE_HOURS)
        expect(content).not.toMatch(/(?<!LEGACY_)T2_DEADLINE_HOURS/);
      }
    });
  });

  describe("Preset Files", () => {
    test("should have mirai-shachu preset file with tenant values", () => {
      const content = readFile("lib/approval-kind-routes/presets/mirai-shachu.ts");
      expect(content.length).toBeGreaterThan(0);

      // Should contain the tenant-specific values
      for (const keyword of MIRAI_SHACHU_T3_KEYWORDS.slice(0, 3)) {
        expect(content).toContain(keyword);
      }
      expect(content).toContain("500000");
    });

    test("should have neutral defaults preset file", () => {
      const content = readFile("lib/approval-kind-routes/presets/defaults.ts");
      expect(content.length).toBeGreaterThan(0);

      // Should contain default constants (but NOT amount threshold)
      expect(content).toContain("DEFAULT_CONSUMPTION_TAX_RATE");
      expect(content).toContain("DEFAULT_FISCAL_YEAR_START_MONTH");
      expect(content).toContain("DEFAULT_REMIND_EVERY_DAYS");
    });
  });

  describe("Config-Based Behavior", () => {
    test("request.ts should get tax rate from config", () => {
      const content = readFile("lib/decision-workflow/request.ts");
      expect(content).toContain("config?.consumptionTaxRate");
      expect(content).toContain("DEFAULT_CONSUMPTION_TAX_RATE");
    });

    test("request.ts should NOT import T3_AUTO_ESCALATION_KEYWORDS", () => {
      const content = readFile("lib/decision-workflow/request.ts");
      expect(content).not.toContain("T3_AUTO_ESCALATION_KEYWORDS");
    });

    test("request.ts should NOT import CONSUMPTION_TAX_RATE from types", () => {
      const content = readFile("lib/decision-workflow/request.ts");
      // Should not import CONSUMPTION_TAX_RATE (should use DEFAULT_CONSUMPTION_TAX_RATE from presets)
      expect(content).not.toMatch(/import.*CONSUMPTION_TAX_RATE.*from.*types/);
    });

    test("request.ts should get deadline from tier route", () => {
      const content = readFile("lib/decision-workflow/request.ts");
      expect(content).toContain("tierRoute?.deadlineHours");
      expect(content).not.toContain("T2_DEADLINE_HOURS");
    });

    test("request.ts should use tierRouting for escalation", () => {
      const content = readFile("lib/decision-workflow/request.ts");
      expect(content).toContain("tierRouting");
      expect(content).toContain("containsKeywords");
    });

    test("expiry.ts should check onExpire from tier config", () => {
      const content = readFile("lib/decision-workflow/expiry.ts");
      expect(content).toContain("getOnExpireBehavior");
      expect(content).toContain("tierRoute.onExpire");
    });

    test("data.ts should use DEFAULT_REMIND_EVERY_DAYS constant", () => {
      const content = readFile("lib/approval-kind-routes/data.ts");
      expect(content).toContain("DEFAULT_REMIND_EVERY_DAYS");
      // Should not have hardcoded remindEveryDays: 3
      const lines = getFileLines(content);
      for (const line of lines) {
        if (isCommentLine(line)) continue;
        if (line.includes("remindEveryDays:") && line.includes("3")) {
          expect(line).toContain("DEFAULT_REMIND_EVERY_DAYS");
        }
      }
    });

    test("topic-gate.ts should not fallback to DEFAULT_SENSITIVE_TOPICS", () => {
      const content = readFile("lib/decision-workflow/topic-gate.ts");
      expect(content).not.toContain("sensitiveTopics.length > 0");
    });
  });

  describe("engine.ts determineDecisionTier", () => {
    test("should NOT auto-escalate based on amounts or keywords", () => {
      const content = readFile("lib/approval-kind-routes/engine.ts");
      
      // Check that determineDecisionTier doesn't have amount/keyword escalation logic
      // It should just return the lowest-rank tier
      const lines = getFileLines(content);
      let inDetermineDecisionTier = false;
      
      for (const line of lines) {
        if (line.includes("export function determineDecisionTier")) {
          inDetermineDecisionTier = true;
        }
        if (inDetermineDecisionTier && line.startsWith("}")) {
          break;
        }
        if (inDetermineDecisionTier && !isCommentLine(line)) {
          // Should not have amount comparison for escalation
          expect(line).not.toMatch(/amountJpy\s*>=\s*amountThreshold/);
          // Should not have t3Classifications array
          expect(line).not.toMatch(/t3Classifications\s*=\s*\[/);
        }
      }
    });
  });
});
