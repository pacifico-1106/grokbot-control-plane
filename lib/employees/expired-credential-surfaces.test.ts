/**
 * 木村 2026-10-12 follow-up to #330: four more places treated an expired
 * 社員証 as active. Each now lists such an employee as 「期限切れ」 (not as an
 * active / ready employee), from the credential's expires_at only, filtered by
 * org; key material never appears.
 *   - setup.slackDmApprovalStatus (lib/admin-mcp/slack-dm-setup.ts)
 *   - setup.slackStatus (lib/slack/slack-status-diagnose.ts)
 *   - setup.lineApprovalStatus (lib/line/line-approval-status-diagnose.ts)
 *   - home page AI社員 count (app/app/page.tsx)
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { SessionContext } from "@/lib/auth/session";
import { DEMO_EMPLOYEES, DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import type { Employee } from "@/lib/types";

const ORG = DEMO_ORG.id;
const OTHER = "org_expired_surface_other";
const PAST = "2026-09-23T03:00:00.000Z";
const FUTURE = () => new Date(Date.now() + 30 * 86_400_000).toISOString();
const SECRET = /gb_emp_[A-Za-z0-9]{8,}|secret_hash|secretHash|secret_prefix|oneTimeSecret/;

const session: SessionContext = {
  demo: false,
  userId: "u-admin",
  email: "admin@example.com",
  orgId: ORG,
  member: { id: "mem-admin", orgId: ORG, email: "admin@example.com", displayName: "admin", role: "admin", status: "active", capabilities: ["view_dashboard", "view_employees", "hire_issue_credentials"] },
};
mock.module("@/lib/auth/session", () => ({ getSessionContext: async () => session, getCurrentOrgId: async () => session.orgId }));
mock.module("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const html = (el: ReactNode) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, el));

let seq = 0;
function seed(orgId: string, credentialExpiresAt: string | null, extra: Partial<Employee> = {}): Employee {
  seq += 1;
  const e: Employee = {
    ...DEMO_EMPLOYEES[0],
    id: `emp_surf_${seq}`,
    orgId,
    displayName: `期限面${seq}`,
    status: "active",
    credentialId: `cred_surf_${seq}`,
    credentialExpiresAt,
    postingAs: "bot",
    ...extra,
  };
  getRuntimeEmployees().unshift(e);
  return e;
}

let expired: Employee;
let valid: Employee;
let foreignExpired: Employee;
const realFetch = globalThis.fetch;
beforeAll(() => {
  // Slack / LINE probes must not leave the box.
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "not_authed" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  expired = seed(ORG, PAST);
  valid = seed(ORG, FUTURE());
  foreignExpired = seed(OTHER, PAST);
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

type Row = { employeeId: string; statusLabelJa?: string; credentialExpiresAt?: string | null };
const ids = (rows: unknown) => ((rows as Row[] | undefined) ?? []).map((r) => r.employeeId);

describe("setup.slackDmApprovalStatus", () => {
  test("expired employee → expiredEmployees (期限切れ + expiry), not an active row; reissue step; org-filtered; no key material", async () => {
    const { diagnoseSlackDmApprovalSetup } = await import("@/lib/admin-mcp/slack-dm-setup");
    const out = await diagnoseSlackDmApprovalSetup(ORG);
    expect(ids(out.employees)).not.toContain(expired.id);
    expect(ids(out.employees)).toContain(valid.id);
    const rows = out.expiredEmployees as Row[];
    expect(ids(rows)).toContain(expired.id);
    expect(ids(rows)).not.toContain(foreignExpired.id);
    expect(rows.find((r) => r.employeeId === expired.id)).toMatchObject({ statusLabelJa: "期限切れ", credentialExpiresAt: PAST });
    const steps = (out.nextStepsJa as string[]).join("\n");
    expect(steps).toContain(`${expired.displayName}: 社員証が期限切れ`);
    expect(steps).toContain(`/app/employees/${expired.id}`);
    expect(JSON.stringify(out)).not.toContain(foreignExpired.id);
    expect(JSON.stringify(out)).not.toMatch(SECRET);
  });
});

describe("setup.slackStatus", () => {
  test("expired employee → expiredEmployees + issue, not in employees / path counts; org-filtered", async () => {
    const { diagnoseSlackStatus } = await import("@/lib/slack/slack-status-diagnose");
    const out = (await diagnoseSlackStatus(ORG)) as unknown as Record<string, unknown>;
    expect(ids(out.employees)).not.toContain(expired.id);
    expect(ids(out.employees)).toContain(valid.id);
    expect(ids(out.employees)).not.toContain(foreignExpired.id);
    const rows = out.expiredEmployees as Row[];
    expect(rows.find((r) => r.employeeId === expired.id)).toMatchObject({ statusLabelJa: "期限切れ", credentialExpiresAt: PAST });
    expect(ids(rows)).not.toContain(foreignExpired.id);
    expect((out.issues as string[]).some((i) => i.includes(`${expired.displayName}: 社員証が期限切れ`))).toBe(true);
    expect(JSON.stringify(out)).not.toContain(foreignExpired.id);
    expect(JSON.stringify(out)).not.toMatch(SECRET);
  });
});

describe("setup.lineApprovalStatus", () => {
  test("employeeInboxSummary: expired employee is 期限切れ (expiredCount), not counted as line/telegram/unset; org-filtered", async () => {
    const { diagnoseLineApprovalStatus } = await import("@/lib/line/line-approval-status-diagnose");
    const out = (await diagnoseLineApprovalStatus(ORG)) as unknown as { employeeInboxSummary: Record<string, unknown> };
    const s = out.employeeInboxSummary;
    expect(ids(s.employees)).not.toContain(expired.id);
    expect(ids(s.employees)).toContain(valid.id);
    expect(ids(s.employees)).not.toContain(foreignExpired.id);
    expect(ids(s.expiredEmployees)).toContain(expired.id);
    expect(ids(s.expiredEmployees)).not.toContain(foreignExpired.id);
    expect(s.expiredCount).toBe((s.expiredEmployees as Row[]).length);
    expect((s.employees as Row[]).length).toBe(Number(s.lineCount) + Number(s.telegramCount) + Number(s.unsetCount));
    expect(JSON.stringify(out)).not.toMatch(SECRET);
  });
});

describe("home page (/app)", () => {
  test("AI社員 稼働中 count excludes expired 社員証 and shows 期限切れ N; other orgs and non-active never counted", async () => {
    const { default: Home } = await import("@/app/app/page");
    const { listEmployees } = await import("@/lib/data");
    const now = Date.now();
    const mine = (await listEmployees(ORG)).filter((e) => e.orgId === ORG);
    const live = mine.filter((e) => e.status === "active" && e.credentialId && !(e.credentialExpiresAt && Date.parse(e.credentialExpiresAt) <= now)).length;
    const exp = mine.filter((e) => e.status === "active" && e.credentialId && e.credentialExpiresAt && Date.parse(e.credentialExpiresAt) <= now).length;
    expect(exp).toBeGreaterThan(0);
    const out = html(await Home());
    expect(out).toContain(`期限切れ ${exp}`);
    expect(out).toMatch(new RegExp(`>${live}<`));
    expect(out).not.toMatch(SECRET);
  });
});
