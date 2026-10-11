/**
 * 木村 2026-10-12: the AI社員 list / detail showed 「稼働中」 while every
 * 社員証 had expired. They now read the credential's expires_at: an expired
 * credential shows 「期限切れ」 and its expiry; key material is never shown.
 * Renders the real server components (demo data, mocked session + AppShell).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { SessionContext } from "@/lib/auth/session";
import { DEMO_EMPLOYEES, DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";

const ORG = DEMO_ORG.id;
const session: SessionContext = {
  demo: false,
  userId: "u-admin",
  email: "admin@example.com",
  orgId: ORG,
  member: { id: "mem-admin", orgId: ORG, email: "admin@example.com", displayName: "admin", role: "admin", status: "active", capabilities: ["view_dashboard", "view_employees", "hire_issue_credentials"] },
};
mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/components/AppShell", () => ({
  AppShell: ({ children, subtitle }: { children: ReactNode; subtitle?: string }) =>
    createElement("main", null, createElement("p", { "data-subtitle": "1" }, subtitle ?? ""), children),
}));
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const html = (el: ReactNode) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, el));

const { default: EmployeesPage } = await import("./page");
const { default: EmployeeDetailPage } = await import("./[id]/page");

let seq = 0;
function seed(credentialExpiresAt: string | null, credentialId: string | null = `cred_exp_${seq + 1}`): string {
  const id = `emp_exp_${++seq}`;
  getRuntimeEmployees().unshift({ ...DEMO_EMPLOYEES[0], id, displayName: `期限テスト${seq}`, status: "active", credentialId, credentialExpiresAt });
  return id;
}
/** The list row for one employee (mobile card <li> or desktop <tr>). */
function rows(out: string, id: string): string[] {
  const parts = out.split(/<li |<tr /).filter((p) => p.includes(`/app/employees/${id}"`));
  expect(parts.length).toBeGreaterThan(0);
  return parts;
}
const SECRET_MARKERS = [/gb_emp_[A-Za-z0-9]{8,}/, /secret_hash/i, /secretHash/, /oneTimeSecret/];

beforeEach(() => undefined);

describe("AI社員 list", () => {
  test("expired credential → 期限切れ + expiry date, not 稼働中", async () => {
    const id = seed("2026-09-23T03:00:00.000Z");
    const out = html(await EmployeesPage());
    for (const row of rows(out, id)) {
      expect(row).toContain("期限切れ");
      expect(row).not.toContain("稼働中");
      expect(row).toContain("2026/09/23 12:00 JST");
    }
  });
  test("valid credential → 稼働中 + its expiry date", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const id = seed(future);
    const out = html(await EmployeesPage());
    for (const row of rows(out, id)) {
      expect(row).toContain("稼働中");
      expect(row).not.toContain("期限切れ");
      expect(row).toContain("社員証期限");
    }
  });
  test("expiring within 7 days → 稼働中 plus あと N 日", async () => {
    const id = seed(new Date(Date.now() + 2 * 86_400_000 - 60_000).toISOString());
    const out = html(await EmployeesPage());
    for (const row of rows(out, id)) expect(row).toContain("あと 2 日");
  });
  test("no expiry → 無期限; no credential → 社員証なし", async () => {
    const a = seed(null);
    const b = seed(null, null);
    const out = html(await EmployeesPage());
    for (const row of rows(out, a)) expect(row).toContain("無期限");
    for (const row of rows(out, b)) {
      expect(row).toContain("社員証なし");
      expect(row).not.toContain("稼働中");
    }
  });
  test("never renders key material", async () => {
    seed("2026-09-23T03:00:00.000Z");
    const out = html(await EmployeesPage());
    for (const re of SECRET_MARKERS) expect(re.test(out)).toBe(false);
  });
});

describe("AI社員 detail", () => {
  test("expired credential → subtitle 期限切れ, 有効期限 row with the date and a re-issue hint", async () => {
    const id = seed("2026-09-30T14:59:00.000Z");
    const out = html(await EmployeeDetailPage({ params: Promise.resolve({ id }) }));
    const subtitle = /data-subtitle="1">([^<]*)</.exec(out)?.[1] ?? "";
    expect(subtitle).toContain("期限切れ");
    expect(subtitle).not.toContain("稼働中");
    expect(out).toContain("社員証の有効期限");
    expect(out).toContain("2026/09/30 23:59 JST");
    expect(out).toContain("社員証を再発行");
    for (const re of SECRET_MARKERS) expect(re.test(out)).toBe(false);
  });
  test("no expiry → 無期限; valid → 稼働中", async () => {
    const id = seed(null);
    const out = html(await EmployeeDetailPage({ params: Promise.resolve({ id }) }));
    expect(/data-subtitle="1">([^<]*)</.exec(out)?.[1]).toContain("稼働中");
    expect(out).toContain("無期限");
  });
});
