import { describe, expect, test } from "bun:test";
import { evaluateActionLimit } from "./action-gate";
import { startOfTokyoDayIso, tokyoActionPeriod } from "./data/action-counters";

describe("action limits", () => {
  test("allows tools without a configured limit", () => {
    expect(evaluateActionLimit({ tool: "mail.send", limits: {}, countToday: 999, countThisMonth: 999 }).decision).toBe("allow");
  });

  test("requires approval at the limit and denies at twice the limit", () => {
    const limits = { "mail.send": { perDay: 2, perMonth: 20 } };
    expect(evaluateActionLimit({ tool: "mail.send", limits, countToday: 2, countThisMonth: 2 }).decision).toBe("needs_approval");
    expect(evaluateActionLimit({ tool: "mail.send", limits, countToday: 4, countThisMonth: 4 }).decision).toBe("deny");
  });

  test("evaluates the monthly threshold independently", () => {
    const limits = { "commerce.order": { perMonth: 5 } };
    expect(evaluateActionLimit({ tool: "commerce.order", limits, countToday: 0, countThisMonth: 5 }).reason).toBe("action_limit_month_reached");
  });

  test("rolls the period over at midnight in Asia/Tokyo", () => {
    expect(tokyoActionPeriod(new Date("2026-08-31T14:59:59Z"))).toBe("2026-08");
    expect(tokyoActionPeriod(new Date("2026-08-31T15:00:00Z"))).toBe("2026-09");
    expect(startOfTokyoDayIso(new Date("2026-08-31T16:00:00Z"))).toBe("2026-08-31T15:00:00.000Z");
  });
});
