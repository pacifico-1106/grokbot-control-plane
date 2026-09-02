import { describe, expect, test } from "bun:test";
import {
  ALWAYS_ON_HREFS,
  COLLAPSED_HREFS,
  GUIDE_NAV,
  OTHER_NAV,
  OTHER_SECTION_LABEL,
  PRIMARY_NAV,
} from "@/lib/dashboard/nav";
import { orgNeedsSetup } from "@/lib/dashboard/setup-state";

describe("dashboard shell nav", () => {
  test("always-visible items are 変更ログ / 承認 / 閲覧", () => {
    expect(PRIMARY_NAV.map((i) => i.label)).toEqual(["変更ログ", "承認", "閲覧"]);
    expect(ALWAYS_ON_HREFS).toEqual(["/app", "/app/approvals", "/app/audit"]);
  });

  test("employees/new is not always-on and hire wizard is not in その他 as daily path", () => {
    expect(ALWAYS_ON_HREFS.includes("/app/employees/new")).toBe(false);
    expect(COLLAPSED_HREFS.includes("/app/employees/new")).toBe(false);
    expect(OTHER_NAV.map((i) => i.href)).toContain("/app/employees");
    expect(OTHER_SECTION_LABEL).toBe("その他");
    expect(GUIDE_NAV.some((i) => i.href === "/app/getting-started")).toBe(true);
  });

  test("setup shows when admin MCP is missing or no employee confirmed", () => {
    expect(orgNeedsSetup({ adminMcpConnected: false, confirmedEmployeeCount: 0 })).toBe(true);
    expect(orgNeedsSetup({ adminMcpConnected: true, confirmedEmployeeCount: 0 })).toBe(true);
    expect(orgNeedsSetup({ adminMcpConnected: false, confirmedEmployeeCount: 2 })).toBe(true);
    expect(orgNeedsSetup({ adminMcpConnected: true, confirmedEmployeeCount: 1 })).toBe(false);
  });
});
