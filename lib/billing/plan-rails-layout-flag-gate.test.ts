import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The /app layout runs on every page. With P1_PLAN_RAILS_ENABLED OFF it must
 * not query the plan columns (they may not exist before the plan_rails
 * migration is applied).
 */
describe("app layout plan-rails flag gate", () => {
  test("getOrgPlanInfo is only called behind the flag", () => {
    const src = readFileSync(resolve("app/app/layout.tsx"), "utf8");
    const calls = src.match(/getOrgPlanInfo\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(src).toMatch(/planRailsEnabled\s*\?\s*await getOrgPlanInfo\(/);
  });
});
