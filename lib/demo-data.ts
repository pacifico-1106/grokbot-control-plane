import { ensureBindingRow, seedDemoBindings } from "./bindings";
import type {
  ApprovalRequest,
  AuditEvent,
  Employee,
  GatewayLinkStatus,
  OrgMember,
  Subscription,
} from "./types";

export const DEMO_ORG = {
  id: "org_demo",
  name: "株式会社サンプル商事",
  integrationMode: "managed" as const,
  gatewayStatus: "linked" as GatewayLinkStatus,
  trialEndsAt: new Date(Date.now() + 14 * 86400000).toISOString(),
};

export const DEMO_EMPLOYEES: Employee[] = [
  {
    id: "emp_sales",
    orgId: DEMO_ORG.id,
    displayName: "営業AI社員",
    roleLabel: "営業アシスタント",
    jobDescription: "見積作成と顧客フォローの下書きを担当",
    status: "active",
    scopes: [
      "tools:read",
      "mail:draft",
      "commerce:quote",
      "approvals:request",
      "audit:append",
    ],
    allowedPurposes: ["sales.outreach", "commerce.quote"],
    approvalPolicy: "risk_based",
    credentialId: "cred_sales",
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
  {
    id: "emp_ops",
    orgId: DEMO_ORG.id,
    displayName: "事務AI社員",
    roleLabel: "バックオフィス",
    jobDescription: "請求確認と社内資料の整理",
    status: "active",
    scopes: [
      "tools:read",
      "files:read",
      "mail:draft",
      "approvals:request",
      "audit:append",
    ],
    allowedPurposes: ["ops.admin", "invoice.check"],
    approvalPolicy: "risk_based",
    credentialId: "cred_ops",
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
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
    summary: "デモ用資材 1件の購入実行",
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
    metadata: { sharedHost: true, risk: "medium" },
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
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    action: "credential.issued",
    purpose: null,
    summary: "営業AI社員の社員証を発行",
    metadata: { scopes: ["mail:draft", "commerce:quote"] },
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: "aud_4",
    orgId: DEMO_ORG.id,
    employeeId: null,
    credentialId: null,
    action: "gateway.link_changed",
    purpose: null,
    summary: "Grok Bot 連携ステータスが linked になりました",
    metadata: { from: "pending", to: "linked", mode: "managed" },
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
];

export const DEMO_MEMBERS: OrgMember[] = [
  {
    id: "mem_1",
    orgId: DEMO_ORG.id,
    email: "owner@example.com",
    displayName: "山田 太郎",
    role: "owner",
    status: "active",
  },
  {
    id: "mem_2",
    orgId: DEMO_ORG.id,
    email: "admin@example.com",
    displayName: "佐藤 花子",
    role: "admin",
    status: "active",
  },
];

export const DEMO_SUBSCRIPTION: Subscription = {
  id: "sub_demo",
  orgId: DEMO_ORG.id,
  planKey: "business",
  status: "trialing",
  stripeSubscriptionId: null,
  trialEndsAt: DEMO_ORG.trialEndsAt,
  currentPeriodEnd: null,
};

/** In-memory demo store mutations for hire / approve flows (process-local). */
const runtimeEmployees: Employee[] = [...DEMO_EMPLOYEES];
const runtimeApprovals: ApprovalRequest[] = [...DEMO_APPROVALS];
const runtimeAudit: AuditEvent[] = [...DEMO_AUDIT];
let gatewayStatus: GatewayLinkStatus = DEMO_ORG.gatewayStatus;

export function getRuntimeEmployees() {
  return runtimeEmployees;
}

export function getRuntimeApprovals() {
  return runtimeApprovals;
}

export function getRuntimeAudit() {
  return runtimeAudit;
}

export function getGatewayStatus() {
  return gatewayStatus;
}

export function setGatewayStatus(status: GatewayLinkStatus) {
  gatewayStatus = status;
  runtimeAudit.unshift({
    id: `aud_${Date.now()}`,
    orgId: DEMO_ORG.id,
    employeeId: null,
    credentialId: null,
    action: "gateway.link_changed",
    purpose: null,
    summary: `Grok Bot 連携ステータスが ${status} になりました`,
    metadata: { to: status },
    createdAt: new Date().toISOString(),
  });
}

export function addRuntimeEmployee(employee: Employee, auditSummary: string) {
  runtimeEmployees.unshift(employee);
  ensureBindingRow(employee.id, employee.orgId);
  runtimeAudit.unshift({
    id: `aud_${Date.now()}`,
    orgId: DEMO_ORG.id,
    employeeId: employee.id,
    credentialId: employee.credentialId,
    action: "credential.issued",
    purpose: null,
    summary: auditSummary,
    metadata: {
      scopes: employee.scopes,
      purposes: employee.allowedPurposes,
      approvalPolicy: employee.approvalPolicy,
      spend: employee.spend ?? null,
    },
    createdAt: new Date().toISOString(),
  });
}

export function resolveRuntimeApproval(
  id: string,
  status: "approved" | "rejected",
  resolvedBy = "owner@example.com"
) {
  const idx = runtimeApprovals.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const next = {
    ...runtimeApprovals[idx],
    status,
    resolvedAt: new Date().toISOString(),
    resolvedBy,
  };
  runtimeApprovals[idx] = next;
  runtimeAudit.unshift({
    id: `aud_${Date.now()}`,
    orgId: DEMO_ORG.id,
    employeeId: next.employeeId,
    credentialId: next.credentialId,
    action: "approval.resolved",
    purpose: next.purpose,
    summary: status === "approved" ? `承認: ${next.summary}` : `却下: ${next.summary}`,
    metadata: { decision: status, resolvedBy },
    createdAt: new Date().toISOString(),
  });
  return next;
}

// DEMO: seed durable bindings for sample employees (in-memory; labeled DEMO).
seedDemoBindings(
  runtimeEmployees.map((e) => ({ id: e.id, orgId: e.orgId })),
  { linkSales: true }
);

export { countNeedsReauth, listBindingsForOrg, getBinding } from "./bindings";
