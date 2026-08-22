import type { ApprovalRequest, AuditEvent, Employee } from "./types";

export const DEMO_ORG = {
  id: "org_demo",
  name: "株式会社サンプル商事",
  integrationMode: "managed" as const,
  trialEndsAt: new Date(Date.now() + 14 * 86400000).toISOString(),
};

export const DEMO_EMPLOYEES: Employee[] = [
  {
    id: "emp_sales",
    orgId: DEMO_ORG.id,
    displayName: "営業AI社員",
    roleLabel: "営業アシスタント",
    status: "active",
  },
  {
    id: "emp_ops",
    orgId: DEMO_ORG.id,
    displayName: "事務AI社員",
    roleLabel: "バックオフィス",
    status: "active",
  },
];

export const DEMO_APPROVALS: ApprovalRequest[] = [
  {
    id: "apr_1",
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    purpose: "commerce.quote",
    summary: "顧客A向け見積メール下書きの外部送信",
    risk: "medium",
    status: "pending",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  },
  {
    id: "apr_2",
    orgId: DEMO_ORG.id,
    employeeId: "emp_ops",
    credentialId: "cred_ops",
    purpose: "commerce.order",
    summary: "デモ用 eSIM 1件の購入実行",
    risk: "high",
    status: "pending",
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  },
];

export const DEMO_AUDIT: AuditEvent[] = [
  {
    id: "aud_1",
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    action: "approval.requested",
    purpose: "commerce.quote",
    summary: "外部送信が承認待ちになりました",
    metadata: { sharedHost: true },
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: "aud_2",
    orgId: DEMO_ORG.id,
    employeeId: "emp_ops",
    credentialId: "cred_ops",
    action: "tool.invoke",
    purpose: "tools.read",
    summary: "在庫一覧を読み取りました",
    metadata: { tool: "inventory.list" },
    createdAt: new Date(Date.now() - 5400000).toISOString(),
  },
  {
    id: "aud_3",
    orgId: DEMO_ORG.id,
    employeeId: null,
    credentialId: null,
    action: "credential.issued",
    purpose: null,
    summary: "営業AI社員の社員証を発行",
    metadata: {},
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
];
