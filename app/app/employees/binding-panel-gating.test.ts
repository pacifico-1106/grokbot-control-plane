/**
 * 木村 2026-10-04 (#6): BindingPanel shows 社員証を再発行 and 起こす webhook を保存
 * only when the session passes the SAME check the API uses, decided on the
 * server (not CSS):
 * - POST /api/employees/[id]/rotate  → requireCredentialAdmin
 *     = owner/admin role AND hire_issue_credentials (canIssueEmployeeCredentials)
 * - PATCH /api/employees/[id]/binding → requireCapability("hire_issue_credentials")
 * - POST link / health               → requireOrgAdminSession (isOrgAdminSession)
 * Demo mode keeps the existing page convention (session.demo → allowed).
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { SessionContext } from "@/lib/auth/session";
import { DEMO_EMPLOYEES, DEMO_ORG } from "@/lib/demo-data";
import type { EmployeeBinding, HumanCapability, OrgMember } from "@/lib/types";

const ORG = DEMO_ORG.id;
const sessionFor = (role: OrgMember["role"] | null, capabilities: HumanCapability[] = []): SessionContext =>
  role
    ? {
        demo: false,
        userId: `u-${role}`,
        email: `${role}@example.com`,
        orgId: ORG,
        member: { id: `mem-${role}`, orgId: ORG, email: `${role}@example.com`, displayName: role, role, status: "active", capabilities },
      }
    : { demo: false, userId: null, email: null, orgId: null, member: null };
let session = sessionFor("member");
mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));

const { bindingPanelPermissions } = await import("@/lib/employees/binding-panel-permissions");
const { BindingPanel } = await import("@/components/employees/BindingPanel");
const { default: EmployeeDetailPage } = await import("./[id]/page");

const HIRE: HumanCapability[] = ["view_dashboard", "hire_issue_credentials"];
const ROTATE = ">社員証を再発行<";
const WAKE_SAVE = ">起こす webhook を保存<";

describe("bindingPanelPermissions mirrors the API gates", () => {
  test("owner/admin with hire_issue_credentials → everything", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(bindingPanelPermissions(sessionFor(role, HIRE))).toEqual({
        canManageBinding: true,
        canRotateCredential: true,
        canEditWakeWebhook: true,
      });
    }
  });
  test("admin without hire_issue_credentials → link/health only", () => {
    expect(bindingPanelPermissions(sessionFor("admin", ["view_dashboard"]))).toEqual({
      canManageBinding: true,
      canRotateCredential: false,
      canEditWakeWebhook: false,
    });
  });
  test("member with hire_issue_credentials → wake webhook (capability gate) but no rotate (role gate)", () => {
    expect(bindingPanelPermissions(sessionFor("member", HIRE))).toEqual({
      canManageBinding: false,
      canRotateCredential: false,
      canEditWakeWebhook: true,
    });
  });
  test("member without the capability / no session → nothing", () => {
    const none = { canManageBinding: false, canRotateCredential: false, canEditWakeWebhook: false };
    expect(bindingPanelPermissions(sessionFor("member", ["view_dashboard"]))).toEqual(none);
    expect(bindingPanelPermissions(sessionFor(null))).toEqual(none);
  });
  test("demo session keeps the existing page convention (allowed)", () => {
    expect(bindingPanelPermissions({ demo: true, userId: null, email: null, orgId: ORG, member: null })).toEqual({
      canManageBinding: true,
      canRotateCredential: true,
      canEditWakeWebhook: true,
    });
  });
});

describe("BindingPanel renders only the permitted controls", () => {
  const binding: EmployeeBinding = {
    employeeId: "emp-1",
    orgId: ORG,
    grokBotAgentId: null,
    grokBotWorkspaceId: null,
    credentialGeneration: 1,
    credentialFingerprint: null,
    status: "linked",
    lastSuccessAt: null,
    lastError: null,
    wakeWebhookUrl: "https://hooks.example.com/wake",
    hasWakeWebhook: true,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  };
  const render = (p: { canRotateCredential: boolean; canEditWakeWebhook: boolean }) =>
    renderToStaticMarkup(createElement(BindingPanel, { employeeId: "emp-1", initial: binding, canManageBinding: false, ...p }));

  test("without rotate / wake permission: no 再発行 button, no wake form (URL shown read-only)", () => {
    const out = render({ canRotateCredential: false, canEditWakeWebhook: false });
    expect(out).not.toContain(ROTATE);
    expect(out).not.toContain(WAKE_SAVE);
    expect(out).not.toContain('type="password"');
    expect(out).toContain("https://hooks.example.com/wake");
  });
  test("with both permissions: both controls are rendered", () => {
    const out = render({ canRotateCredential: true, canEditWakeWebhook: true });
    expect(out).toContain(ROTATE);
    expect(out).toContain(WAKE_SAVE);
    expect(out).toContain('type="password"');
  });
  test("each flag only controls its own button", () => {
    const rotateOnly = render({ canRotateCredential: true, canEditWakeWebhook: false });
    expect(rotateOnly).toContain(ROTATE);
    expect(rotateOnly).not.toContain(WAKE_SAVE);
    const wakeOnly = render({ canRotateCredential: false, canEditWakeWebhook: true });
    expect(wakeOnly).not.toContain(ROTATE);
    expect(wakeOnly).toContain(WAKE_SAVE);
  });
});

describe("/app/employees/[id] decides on the server", () => {
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const page = async () =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: router as never },
        await EmployeeDetailPage({ params: Promise.resolve({ id: DEMO_EMPLOYEES[0].id }) })
      )
    );

  test("member without the capability sees neither control", async () => {
    session = sessionFor("member", ["view_dashboard", "view_employees"]);
    const out = await page();
    expect(out).toContain("Grok Bot の接続状態");
    expect(out).not.toContain(ROTATE);
    expect(out).not.toContain(WAKE_SAVE);
  });
  test("owner with hire_issue_credentials sees both", async () => {
    session = sessionFor("owner", HIRE);
    const out = await page();
    expect(out).toContain(ROTATE);
    expect(out).toContain(WAKE_SAVE);
  });
  test("page passes the server decision to BindingPanel", () => {
    const src = readFileSync(new URL("./[id]/page.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/bindingPanelPermissions\(session\)/);
    expect(src).toMatch(/<BindingPanel[\s\S]*\{\.\.\.bindingPermissions\}/);
  });
});
