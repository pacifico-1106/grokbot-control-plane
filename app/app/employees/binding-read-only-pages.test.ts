/**
 * 木村 2026-10-04 (#5): opening /app/integrations, /app/employees/[id] or
 * /app/employees/[id]/actions must not create an employee_bindings row (the
 * pages used to call ensureBindingRow on every render, for any member).
 * Rows are created only by admin actions (POST link / health, issue, rotate…).
 * A missing row is shown as 未接続 (unlinked) for members and admins alike.
 *
 * Renders the real server components (demo data stores, mocked session +
 * AppShell chrome) and checks the binding store afterwards.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { SessionContext } from "@/lib/auth/session";
import { getBinding as storedBinding } from "@/lib/bindings";
import { DEMO_EMPLOYEES, DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import type { HumanCapability, OrgMember } from "@/lib/types";

const ORG = DEMO_ORG.id;
let session: SessionContext;
const as = (role: OrgMember["role"], capabilities: HumanCapability[] = ["view_dashboard", "view_employees"]) => {
  session = {
    demo: false,
    userId: `u-${role}`,
    email: `${role}@example.com`,
    orgId: ORG,
    member: { id: `mem-${role}`, orgId: ORG, email: `${role}@example.com`, displayName: role, role, status: "active", capabilities },
  };
};
mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const html = (el: ReactNode) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, el));

let seq = 0;
/** a fresh demo employee that has no binding row yet */
function employeeWithoutBinding(): string {
  const id = `emp_nobind_${++seq}`;
  getRuntimeEmployees().unshift({ ...DEMO_EMPLOYEES[0], id, displayName: `未連携テスト${seq}`, credentialId: undefined });
  expect(storedBinding(id)).toBeUndefined();
  return id;
}

const { default: EmployeeDetailPage } = await import("./[id]/page");
const { default: EmployeeActionsPage } = await import("./[id]/actions/page");
const { default: IntegrationsPage } = await import("../integrations/page");

beforeEach(() => as("member"));

describe("pages never create a binding row", () => {
  for (const role of ["member", "admin"] as const) {
    test(`${role}: /app/employees/[id] renders 未接続 and leaves no row behind`, async () => {
      as(role, role === "admin" ? ["view_dashboard", "view_employees", "hire_issue_credentials"] : undefined);
      const id = employeeWithoutBinding();
      const out = html(await EmployeeDetailPage({ params: Promise.resolve({ id }) }));
      expect(out).toContain("Grok Bot の接続状態");
      expect(out).toContain("未接続");
      expect(storedBinding(id)).toBeUndefined();
      // admin still gets the link control (it is the admin action that creates the row)
      expect(out.includes(">連携する<")).toBe(role === "admin");
    });

    test(`${role}: /app/employees/[id]/actions renders and leaves no row behind`, async () => {
      as(role);
      const id = employeeWithoutBinding();
      const out = html(await EmployeeActionsPage({ params: Promise.resolve({ id }) }));
      expect(out.length).toBeGreaterThan(0);
      expect(storedBinding(id)).toBeUndefined();
    });

    test(`${role}: /app/integrations lists the employee as 未接続 and leaves no row behind`, async () => {
      as(role);
      const id = employeeWithoutBinding();
      const out = html(await IntegrationsPage());
      expect(out).toContain(`/app/employees/${id}`);
      expect(out).toContain("未接続");
      expect(storedBinding(id)).toBeUndefined();
    });
  }
});

describe("read-only binding lookup", () => {
  test("getBindingForDisplay returns an unlinked placeholder without storing it", async () => {
    const { getBindingForDisplay } = await import("@/lib/data");
    const id = employeeWithoutBinding();
    const b = await getBindingForDisplay(id, ORG);
    expect(b).toMatchObject({ employeeId: id, orgId: ORG, status: "unlinked", grokBotAgentId: null, credentialGeneration: 0 });
    expect(storedBinding(id)).toBeUndefined();
  });

  test("read paths do not reference ensureBindingRow", () => {
    for (const f of [
      "app/app/employees/[id]/page.tsx",
      "app/app/employees/[id]/actions/page.tsx",
      "app/app/integrations/page.tsx",
      "app/api/employees/[id]/binding/route.ts",
    ]) {
      const src = readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
      const read = f.endsWith("route.ts") ? src.slice(src.indexOf("export async function GET"), src.indexOf("export async function PATCH")) : src;
      expect(`${f}:${/ensureBindingRow/.test(read)}`).toBe(`${f}:false`);
    }
  });
});
