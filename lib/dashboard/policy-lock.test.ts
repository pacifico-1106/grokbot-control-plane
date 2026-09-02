import { describe, expect, test } from "bun:test";
import { dashboardLockedPolicyChanged } from "@/lib/dashboard/policy-lock";

describe("dashboard policy lock (scopes / purposes / actionLimits)", () => {
  test("identity-style re-post of existing fields is allowed", () => {
    expect(
      dashboardLockedPolicyChanged({
        existing: {
          scopes: ["tools:read", "mail:draft"],
          allowedPurposes: ["ops.admin"],
          actionLimits: { "mail.draft": { perDay: 20 } },
        },
        posted: {
          scopes: ["mail:draft", "tools:read"],
          allowedPurposes: ["ops.admin"],
          actionLimits: { "mail.draft": { perDay: 20 } },
        },
      })
    ).toBe(false);
  });

  test("scope change is locked", () => {
    expect(
      dashboardLockedPolicyChanged({
        existing: { scopes: ["tools:read"], allowedPurposes: [], actionLimits: {} },
        posted: { scopes: ["tools:read", "mail:send"], allowedPurposes: [], actionLimits: {} },
      })
    ).toBe(true);
  });

  test("purpose change is locked", () => {
    expect(
      dashboardLockedPolicyChanged({
        existing: { scopes: ["tools:read"], allowedPurposes: ["ops.admin"], actionLimits: {} },
        posted: { scopes: ["tools:read"], allowedPurposes: ["sales.follow"], actionLimits: {} },
      })
    ).toBe(true);
  });

  test("actionLimits change is locked", () => {
    expect(
      dashboardLockedPolicyChanged({
        existing: { scopes: ["tools:read"], allowedPurposes: [], actionLimits: { "mail.send": { perDay: 5 } } },
        posted: { scopes: ["tools:read"], allowedPurposes: [], actionLimits: { "mail.send": { perDay: 50 } } },
      })
    ).toBe(true);
  });
});
