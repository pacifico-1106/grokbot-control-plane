import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  LINE_COMM_ACCOUNT_CONNECT_BUTTON_JA,
  LINE_COMM_ACCOUNT_FAIL_FALLBACK_JA,
  LINE_COMM_ACCOUNT_PAGE_PATH,
  LINE_COMM_ACCOUNT_SECTION_TITLE_JA,
  LINE_COMM_ACCOUNT_SUCCESS_JA,
  LINE_COMM_LINK_ISSUE_BUTTON_JA,
  LINE_COMM_LINK_ISSUE_FAIL_JA,
  LINE_COMM_LINK_SECTION_TITLE_JA,
  LINE_CONVERSATION_LINK_FAIL_JA,
  LINE_CONVERSATION_LINK_GROUP_JA,
  LINE_CONVERSATION_LINK_OK_JA,
  LINE_QUOTA_80_NOTICE_OPS_JA,
  LINE_QUOTA_80_NOTICE_TENANT_ADMIN_BODY_JA,
  LINE_QUOTA_80_NOTICE_TENANT_ADMIN_SUBJECT_JA,
} from "@/lib/comm/line-poc-copy";
import { LINE_CONVERSATION_LINKED_REPLY } from "@/lib/comm/line-link";
import { LINE_POC_ENV_NAMES } from "@/lib/comm/line-poc-env";
import { LINE_429_MONTHLY_LIMIT_MESSAGE, LINE_429_RATE_LIMIT_MESSAGE } from "@/lib/comm/line-429-official";
import { classifyLine429 } from "@/lib/comm/line-send";
import { LINE_WEB_ONLY_HIGH_RISK } from "@/lib/comm/line-web-only-high-risk";

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("LP-UI-01 constants are the screen source", () => {
  test("page path and section titles are used by the employee page / forms", () => {
    expect(LINE_COMM_ACCOUNT_PAGE_PATH).toBe("/app/employees/:employeeId");
    expect(src("app/app/employees/[id]/page.tsx")).toContain("LINE_COMM_ACCOUNT_SECTION_TITLE_JA");
    expect(src("app/app/employees/[id]/page.tsx")).toContain("LINE_COMM_LINK_SECTION_TITLE_JA");
    expect(src("components/employees/EmployeeLineCommAccountForm.tsx")).toContain("LINE_COMM_ACCOUNT_CONNECT_BUTTON_JA");
    expect(src("components/employees/EmployeeLineCommAccountForm.tsx")).toContain("LINE_COMM_ACCOUNT_SUCCESS_JA");
    expect(src("components/employees/EmployeeLineCommAccountForm.tsx")).toContain("LINE_COMM_ACCOUNT_FAIL_FALLBACK_JA");
    expect(src("components/employees/EmployeeLineLinkCodeForm.tsx")).toContain("LINE_COMM_LINK_ISSUE_BUTTON_JA");
    expect(src("components/employees/EmployeeLineLinkCodeForm.tsx")).toContain("LINE_COMM_LINK_ISSUE_FAIL_JA");
    expect(LINE_COMM_ACCOUNT_SECTION_TITLE_JA).toBe("LINE 公式アカウント（会話）");
    expect(LINE_COMM_LINK_SECTION_TITLE_JA).toBe("LINE 会話の連携コード");
    expect(LINE_COMM_ACCOUNT_CONNECT_BUTTON_JA).toBe("接続して Webhook を登録");
    expect(LINE_COMM_ACCOUNT_SUCCESS_JA).toBe("Webhook を登録しました");
    expect(LINE_COMM_ACCOUNT_FAIL_FALLBACK_JA).toBe("接続に失敗しました");
    expect(LINE_COMM_LINK_ISSUE_BUTTON_JA).toBe("連携コードを発行");
    expect(LINE_COMM_LINK_ISSUE_FAIL_JA).toBe("発行に失敗しました");
  });
});

describe("LP-LNK-01 conversation link copy", () => {
  test("success and failure replies are the constants", () => {
    expect(LINE_CONVERSATION_LINKED_REPLY).toBe(LINE_CONVERSATION_LINK_OK_JA);
    expect(LINE_CONVERSATION_LINK_OK_JA).toBe("✅ Staffpass の社内メンバーとして確認しました。");
    expect(LINE_CONVERSATION_LINK_FAIL_JA).toContain("連携コードを確認できませんでした");
    expect(LINE_CONVERSATION_LINK_GROUP_JA).toContain("1:1 トーク");
    expect(src("lib/comm/line-link.ts")).toContain("LINE_CONVERSATION_LINK_FAIL_JA");
  });
});

describe("LP-QTA-04 80% notice copy (U-21, L0 records only)", () => {
  test("tenant-admin mail + ops notice strings exist", () => {
    expect(LINE_QUOTA_80_NOTICE_TENANT_ADMIN_SUBJECT_JA).toContain("8 割");
    expect(LINE_QUOTA_80_NOTICE_TENANT_ADMIN_BODY_JA).toContain("テナント");
    expect(LINE_QUOTA_80_NOTICE_OPS_JA).toContain("運営");
  });
});

describe("LP-QTA-01/06 official 429 messages", () => {
  test("monthly vs rate-limit vs unknown", () => {
    expect(classifyLine429(JSON.stringify({ message: LINE_429_MONTHLY_LIMIT_MESSAGE }))).toBe("line_monthly_quota_exceeded");
    expect(classifyLine429(JSON.stringify({ message: LINE_429_RATE_LIMIT_MESSAGE }))).toBe("line_rate_limited");
    expect(classifyLine429("{}")).toBe("line_not_sent_429");
  });
});

describe("LP-HRK-01 extracted Web-only list", () => {
  test("only hold.release is LINE-blocked in current code", () => {
    expect(LINE_WEB_ONLY_HIGH_RISK.map((x) => x.tool)).toEqual(["employee.hold.release"]);
    expect(LINE_WEB_ONLY_HIGH_RISK[0]?.reason).toBe("hold_release_web_only");
    const holdConfig = src("lib/safety/hold-config.ts");
    expect(holdConfig).toContain('HOLD_RELEASE_SURFACES: readonly HoldStopSurface[] = ["web"]');
    expect(holdConfig).toContain('HOLD_RELEASE_TOOL = "employee.hold.release"');
    expect(src("lib/data/approvals.ts")).toContain("hold_release_web_only");
    expect(src("lib/approvals/workflow-integration.ts")).toContain("hold_release_web_only");
  });
});

describe("E2E-00 env names (no values)", () => {
  test("lists names only", () => {
    expect(LINE_POC_ENV_NAMES).toContain("COMM_CONVERSATION_TOKEN_SECRET");
    expect(LINE_POC_ENV_NAMES).toContain("VOTER_BINDING_SECRET");
    expect(LINE_POC_ENV_NAMES).toContain("NOTIFICATION_CONFIG_ENCRYPTION_KEY");
    expect(LINE_POC_ENV_NAMES.every((n) => /^[A-Z][A-Z0-9_]*$/.test(n))).toBe(true);
    expect(src("lib/comm/line-poc-env.ts")).not.toMatch(/=\s*["'][^"']{8,}/);
  });
});
