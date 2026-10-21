import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  LINE_COMM_ACCOUNT_CONNECT_BUTTON_JA,
  LINE_COMM_ACCOUNT_FAIL_FALLBACK_JA,
  LINE_COMM_ACCOUNT_HELP_JA,
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

describe("client-safe copy module", () => {
  test("line-poc-copy has no server imports (Vercel / Next client bundle)", () => {
    const text = src("lib/comm/line-poc-copy.ts");
    expect(text).not.toMatch(/from ["']@\/lib\/comm\/line-webhook-setup["']/);
    expect(text).not.toMatch(/from ["']@\/lib\/comm\/link-code-guard["']/);
    expect(text).not.toMatch(/from ["']node:/);
  });
});

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
    expect(LINE_COMM_ACCOUNT_HELP_JA).toBe(
      "この社員専用の LINE 公式アカウントを接続します。チャネルアクセストークンはサーバーだけが復号し、ログには残りません。この設定は AI 社員からは変更できません。"
    );
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
  test("tenant-admin mail interpolates employee / usage and omits 本文や秘密", async () => {
    const { LINE_QUOTA_80_NOTICE_TENANT_ADMIN_BODY_OF } = await import("@/lib/comm/line-poc-copy");
    const body = LINE_QUOTA_80_NOTICE_TENANT_ADMIN_BODY_OF({
      employeeDisplayName: "安藤OA",
      used: 1600,
      limit: 2000,
    });
    expect(body).toContain("安藤OA");
    expect(body).toContain("1600");
    expect(body).toContain("2000");
    expect(body).toContain("プラン");
    expect(body).not.toContain("本文や秘密は記録していません");
    expect(LINE_QUOTA_80_NOTICE_TENANT_ADMIN_BODY_JA).not.toContain("本文や秘密は記録していません");
  });

  test("ops notice interpolates org / employee / usage", async () => {
    const { LINE_QUOTA_80_NOTICE_OPS_OF } = await import("@/lib/comm/line-poc-copy");
    const ops = LINE_QUOTA_80_NOTICE_OPS_OF({
      orgName: "TOKYO307",
      orgId: "92f3617c-33fc-4dac-b9b4-d4f42e8522ac",
      employeeDisplayName: "安藤OA",
      used: 1600,
      limit: 2000,
    });
    expect(ops).toContain("TOKYO307");
    expect(ops).toContain("92f3617c-33fc-4dac-b9b4-d4f42e8522ac");
    expect(ops).toContain("安藤OA");
    expect(ops).toContain("1600");
    expect(ops).toContain("2000");
  });

  test("quota-exceeded body drops 他テナント and says until reset or plan change", async () => {
    const { LINE_QUOTA_EXCEEDED_APPROVER_BODY_JA } = await import("@/lib/comm/line-poc-copy");
    expect(LINE_QUOTA_EXCEEDED_APPROVER_BODY_JA).not.toContain("他テナントの承認者には届きません");
    expect(LINE_QUOTA_EXCEEDED_APPROVER_BODY_JA).toMatch(/来月|リセット|プラン/);
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
  test("hold.release remains LINE-blocked", () => {
    expect(LINE_WEB_ONLY_HIGH_RISK.some((x) => x.tool === "employee.hold.release")).toBe(true);
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
