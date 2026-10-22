import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionContext } from "@/lib/auth/session";
import type { AuditEvent, HumanCapability, OrgMember } from "@/lib/types";

const ORG = "org_audit_test";

const member = (caps: HumanCapability[]): OrgMember =>
  ({
    id: "mem_1",
    orgId: ORG,
    email: "owner@example.com",
    displayName: "山田 太郎",
    role: "owner",
    jobRole: "owner",
    capabilities: caps,
    status: "active",
  }) as OrgMember;

let session: SessionContext = {
  demo: false,
  userId: "u1",
  email: "owner@example.com",
  orgId: ORG,
  member: member(["view_dashboard", "view_audit"]),
};

const dirtyEvents: AuditEvent[] = [
  {
    id: "aud_dirty",
    orgId: ORG,
    employeeId: "emp_sales",
    credentialId: "cred_1",
    action: "tool.invoke",
    purpose: "sales.outreach",
    summary: "alice@example.com へ返信",
    metadata: {
      tool: "comm.reply",
      destination: "alice@example.com",
      pollPath: "/api/approvals/status?id=apr&token=SECRETTOKEN",
      statusToken: "st_secret_value",
      approvalId: "apr_ok",
      sent: true,
    },
    createdAt: "2026-10-16T03:34:00.000Z",
  },
  {
    id: "aud_human",
    orgId: ORG,
    employeeId: null,
    credentialId: null,
    actorEmail: "owner@example.com",
    action: "member.updated",
    purpose: null,
    summary: "メンバーを更新",
    metadata: {},
    createdAt: "2026-10-16T03:00:00.000Z",
  },
  {
    id: "aud_policy",
    orgId: ORG,
    employeeId: "emp_sales",
    credentialId: "cred_1",
    actorEmail: "reviewer@example.com",
    action: "admin.policy",
    purpose: "admin.policy",
    summary: "営業AI社員 の権限を人確認のうえで更新",
    metadata: { actorKind: "human", tool: "policy.patch", approvalId: "apr_ok" },
    createdAt: "2026-10-16T03:10:00.000Z",
  },
  {
    id: "aud_hold",
    orgId: ORG,
    employeeId: "emp_sales",
    credentialId: null,
    actorEmail: "owner@example.com",
    action: "employee.hold.started",
    purpose: null,
    summary: "緊急停止を開始",
    metadata: { startedBy: "member:mem_1" },
    createdAt: "2026-10-16T03:05:00.000Z",
  },
  {
    id: "aud_six",
    orgId: ORG,
    employeeId: "emp_sales",
    credentialId: null,
    actorEmail: "reviewer@example.com",
    action: "admin.policy",
    purpose: "admin.policy",
    summary: "社内判定ルールを更新",
    metadata: {
      actorKind: "human",
      tool: "internalAudienceRule.patch",
      approvalId: "apr_ok",
      target: { type: "org_internal_audience_rule", id: ORG },
      reason: { code: "approved", labelJa: "カード確認のうえ実行しました" },
      result: "success",
      ruleSummary: { domainCount: 1, teamCount: 0, autoSlackTeamInternal: false },
      pollPath: "/api/approvals/status?id=apr&token=SIXSECRET",
      statusToken: "st_six_secret",
      destination: "leaked-target@example.com",
      rule: { emailDomains: ["secret-internal.example"] },
    },
    createdAt: "2026-10-16T03:08:00.000Z",
  },
];

const reviewer: OrgMember = {
  id: "mem_reviewer",
  orgId: ORG,
  email: "reviewer@example.com",
  displayName: "佐藤 花子",
  role: "admin",
  jobRole: "admin",
  capabilities: ["view_audit"],
  status: "active",
} as OrgMember;

const listCalls: Array<string | null | undefined> = [];
const approvalOrgCalls: string[] = [];

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/data", () => ({
  listAuditEvents: async (orgId?: string | null) => {
    listCalls.push(orgId);
    return dirtyEvents.filter((e) => e.orgId === orgId);
  },
  listEmployees: async (orgId?: string | null) =>
    orgId === ORG ? [{ id: "emp_sales", displayName: "営業AI社員", orgId: ORG }] : [],
  listMembers: async (orgId?: string | null) =>
    orgId === ORG ? [member(["view_audit"]), reviewer] : [],
  listApprovalsByIds: async (orgId: string, ids: string[]) => {
    approvalOrgCalls.push(orgId);
    if (orgId !== ORG) return [];
    return ids.includes("apr_ok")
      ? [
          {
            id: "apr_ok",
            orgId: ORG,
            status: "approved",
            resolvedBy: "owner@example.com",
            employeeId: "emp_sales",
            jobId: "job_1",
            pollPath: "/api/approvals/status?id=apr_ok&token=SHOULD_NOT_LEAK",
            statusToken: "st_ticket_secret",
          },
        ]
      : [];
  },
  listApprovalsByJobIds: async (orgId: string) => {
    approvalOrgCalls.push(orgId);
    return [];
  },
}));
mock.module("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));

const { default: AuditPage } = await import("./page");

async function html(): Promise<string> {
  return renderToStaticMarkup(await AuditPage());
}

describe("/app/audit readability", () => {
  test("view_audit missing is fail-closed: no events loaded, no secrets", async () => {
    listCalls.length = 0;
    approvalOrgCalls.length = 0;
    session = {
      demo: false,
      userId: "u2",
      email: "sales@example.com",
      orgId: ORG,
      member: member(["view_dashboard", "view_employees"]),
    };
    const out = await html();
    expect(listCalls).toEqual([]);
    expect(approvalOrgCalls).toEqual([]);
    expect(out).toContain("権限がありません");
    expect(out).not.toContain("SECRETTOKEN");
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("pollPath");
  });

  test("authorized page shows Japanese action/result and strips raw JSON / emails", async () => {
    listCalls.length = 0;
    approvalOrgCalls.length = 0;
    session = {
      demo: false,
      userId: "u1",
      email: "owner@example.com",
      orgId: ORG,
      member: member(["view_dashboard", "view_audit"]),
    };
    const out = await html();
    expect(listCalls).toEqual([ORG]);
    expect(out).toContain("Slackにメッセージを送信");
    expect(out).toContain("成功");
    expect(out).toContain("営業AI社員");
    expect(out).toContain("山田 太郎");
    expect(out).toContain("承認済み");
    expect(out).toContain("a***@example.com");
    expect(out).toContain("o***@example.com");
    expect(out).toContain(">人</");
    expect(out).toContain(">AI</");
    expect(approvalOrgCalls.every((id) => id === ORG)).toBe(true);
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("SHOULD_NOT_LEAK");
    expect(out).not.toContain("st_ticket_secret");
    expect(out).not.toContain("SECRETTOKEN");
    expect(out).not.toContain("st_secret_value");
    expect(out).not.toContain("pollPath");
    expect(out).not.toContain("statusToken");
    expect(out).not.toContain("<pre");
    expect(out).not.toMatch(/\{[\s\S]*"tool":\s*"comm.reply"/);
    expect(out).toContain(">AI</");
    expect(out).toContain("営業AI社員");
    expect(out).not.toContain("佐藤 花子");
    expect(out).not.toContain("対象 社内相手ルール");
    expect(out).not.toContain("カード確認のうえ実行しました");
    expect(out).not.toContain("SIXSECRET");
    expect(out).not.toContain("secret-internal.example");
  });

  test("AUDIT_PAGE_SIX_FIELD ON: list shows stored target/reason; secrets stay out", async () => {
    const flag = "AUDIT_PAGE_SIX_FIELD_ENABLED";
    const prev = process.env[flag];
    process.env[flag] = "true";
    try {
      session = {
        demo: false,
        userId: "u1",
        email: "owner@example.com",
        orgId: ORG,
        member: member(["view_dashboard", "view_audit"]),
      };
      const out = await html();
      expect(out).toContain("対象 社内相手ルール");
      expect(out).toContain("カード確認のうえ実行しました");
      expect(out).not.toContain("SIXSECRET");
      expect(out).not.toContain("st_six_secret");
      expect(out).not.toContain("leaked-target@example.com");
      expect(out).not.toContain("secret-internal.example");
      expect(out).not.toContain("pollPath");
      expect(out).not.toContain("statusToken");
    } finally {
      if (prev === undefined) delete process.env[flag];
      else process.env[flag] = prev;
    }
  });

  test("AUDIT_PAGE_ADMIN_WHO ON: policy.patch shows the human, hold trail stays 人", async () => {
    const flag = "AUDIT_PAGE_ADMIN_WHO_ENABLED";
    const prev = process.env[flag];
    process.env[flag] = "true";
    try {
      session = {
        demo: false,
        userId: "u1",
        email: "owner@example.com",
        orgId: ORG,
        member: member(["view_dashboard", "view_audit"]),
      };
      const out = await html();
      expect(out).toContain("佐藤 花子");
      expect(out).toContain("r***@example.com");
      expect(out).toContain(">AI</");
      expect(out).toContain("営業AI社員");
      expect(out).toContain("山田 太郎");
      expect(out).toContain("緊急停止を開始");
      expect(out).not.toContain("reviewer@example.com");
    } finally {
      if (prev === undefined) delete process.env[flag];
      else process.env[flag] = prev;
    }
  });

  test("no org id does not list other tenants' events", async () => {
    listCalls.length = 0;
    session = { demo: false, userId: "u1", email: "x@example.com", orgId: null, member: member(["view_audit"]) };
    const out = await html();
    expect(listCalls).toEqual([]);
    expect(out).toContain("まだ監査イベントがありません");
  });
});
