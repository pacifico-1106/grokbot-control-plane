/**
 * PR-SEC2: the employee page only offers Slack / Google identity connect and
 * disconnect to sessions that pass the SAME gate as the APIs
 * (hire_issue_credentials). Members without it see the current state
 * read-only plus a note on who can change it; the API refusal stays authoritative.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { SessionContext } from "@/lib/auth/session";
import { DEMO_EMPLOYEES, DEMO_ORG } from "@/lib/demo-data";
import type { HumanCapability, OrgMember } from "@/lib/types";

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

const ENV: Record<string, string> = {
  SLACK_CLIENT_ID: "cid",
  SLACK_CLIENT_SECRET: "slack-secret-at-least-32-characters-long",
  GOOGLE_CALENDAR_READ_ENABLED: "true",
  GOOGLE_OAUTH_CLIENT_ID: "gid",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-secret-at-least-32-characters",
};
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const { identityLinkPermissions } = await import("@/lib/employees/identity-link-permissions");
const { SlackIdentityForm } = await import("@/components/employees/SlackIdentityForm");
const { GoogleCalendarIdentityForm } = await import("@/components/employees/GoogleCalendarIdentityForm");
const { default: EmployeeDetailPage } = await import("./[id]/page");

const HIRE: HumanCapability[] = ["view_dashboard", "hire_issue_credentials"];
const SLACK_START = "/api/slack/oauth/start";
const GOOGLE_START = "/api/google/oauth/start";

describe("identityLinkPermissions mirrors the API gate (hire_issue_credentials)", () => {
  test("owner / admin / member WITH the capability → allowed", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      expect(identityLinkPermissions(sessionFor(role, HIRE)).canManageIdentityLinks).toBe(true);
    }
  });
  test("member / admin WITHOUT the capability, or no session → not allowed", () => {
    expect(identityLinkPermissions(sessionFor("member", ["view_dashboard", "manage_team"])).canManageIdentityLinks).toBe(false);
    expect(identityLinkPermissions(sessionFor("admin", ["view_dashboard"])).canManageIdentityLinks).toBe(false);
    expect(identityLinkPermissions(sessionFor(null)).canManageIdentityLinks).toBe(false);
  });
  test("demo session keeps the page convention (allowed)", () => {
    expect(identityLinkPermissions({ demo: true, userId: null, email: null, orgId: ORG, member: null }).canManageIdentityLinks).toBe(true);
  });
});

describe("forms never render a live start link when locked", () => {
  const employee = DEMO_EMPLOYEES[0];
  test("Slack: disabled → no href to the start route", () => {
    const out = renderToStaticMarkup(createElement(SlackIdentityForm, { employee, initialIdentity: null, oauthConfigured: true, disabled: true }));
    expect(out).not.toContain(SLACK_START);
    const open = renderToStaticMarkup(createElement(SlackIdentityForm, { employee, initialIdentity: null, oauthConfigured: true }));
    expect(open).toContain(SLACK_START);
  });
  test("Google: disabled → no href to the start route", () => {
    const props = { employee, initialIdentity: null, oauthConfigured: true, flagEnabled: true };
    expect(renderToStaticMarkup(createElement(GoogleCalendarIdentityForm, { ...props, disabled: true }))).not.toContain(GOOGLE_START);
    expect(renderToStaticMarkup(createElement(GoogleCalendarIdentityForm, props))).toContain(GOOGLE_START);
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

  test("member without hire_issue_credentials: no connect links, explains who can", async () => {
    session = sessionFor("member", ["view_dashboard", "view_employees"]);
    const out = await page();
    expect(out).not.toContain(SLACK_START);
    expect(out).not.toContain(GOOGLE_START);
    expect(out).toContain("雇う／社員証発行");
  });
  test("member with hire_issue_credentials: both connect links", async () => {
    session = sessionFor("member", HIRE);
    const out = await page();
    expect(out).toContain(SLACK_START);
    expect(out).toContain(GOOGLE_START);
  });
});
