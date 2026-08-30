import { ensureBindingRow, seedDemoBindings } from "./bindings";
import {
  buildPollPath,
  generateStatusToken,
  generateTelegramRef,
} from "./approvals/tokens";
import { FRANK_VOICE, POLITE_VOICE } from "./employees/voice";
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
  /** Optional partner code (AIC-XXXX); demo memory only. */
  referralCode: null as string | null,
  sodWarnPolicy: {
    domains: ["comm_external", "money", "destructive", "commit"],
  } as { domains: Array<"comm_external" | "money" | "destructive" | "commit"> },
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
      "tools:invoke",
      "mail:draft",
      "mail:send",
      "calendar:propose",
      "calendar:confirm",
      "commerce:quote",
      "approvals:request",
      "audit:append",
      "slack:post",
    ],
    allowedPurposes: ["sales.outreach", "commerce.quote"],
    approvalPolicy: "always_human",
    sodLevel: "warn",
    actionLimits: { "mail.send": { perDay: 20, perMonth: 300 }, "calendar.confirm": { perDay: 8 } },
    managerId: "mem_1",
    voice: { ...POLITE_VOICE, forbidden: [...POLITE_VOICE.forbidden] },
    projectAccess: { mode: "company", projectIds: [] },
    allowedAccounts: [
      {
        service: "google",
        accountId: "sales-bot@sample-shoji.example",
        label: "営業用Google",
        browserRequired: true,
      },
    ],
    postingAs: "bot",
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
    sodLevel: "ok",
    actionLimits: { "files.write": { perDay: 10 } },
    managerId: "mem_2",
    voice: { ...POLITE_VOICE, forbidden: [...POLITE_VOICE.forbidden] },
    projectAccess: { mode: "company", projectIds: [] },
    postingAs: "bot",
    credentialId: "cred_ops",
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
  {
    id: "emp_comm",
    orgId: DEMO_ORG.id,
    displayName: "社内連絡AI社員",
    roleLabel: "コミュニケーション",
    jobDescription: "社内連絡とナレッジ参照。相手と情報区分で開示を制御する",
    status: "active",
    scopes: [
      "tools:read",
      "tools:invoke",
      "slack:post",
      "calendar:read",
      "knowledge:search",
      "files:read",
      "approvals:request",
      "audit:append",
    ],
    allowedPurposes: ["comm.internal", "knowledge.lookup"],
    approvalPolicy: "risk_based",
    sodLevel: "ok",
    actionLimits: {},
    managerId: "mem_1",
    voice: { ...FRANK_VOICE, forbidden: [] },
    projectAccess: { mode: "company", projectIds: [] },
    postingAs: "bot",
    credentialId: "cred_comm",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: "emp_sns",
    orgId: DEMO_ORG.id,
    displayName: "八坂",
    roleLabel: "個人SNS",
    jobDescription: "X / note / LinkedIn / YouTube の投稿は承認後に出す",
    status: "active",
    scopes: [
      "sns:publish",
      "files:read",
      "files:write",
      "approvals:request",
      "audit:append",
    ],
    allowedPurposes: ["sns.publish"],
    approvalPolicy: "always_human",
    sodLevel: "warn",
    actionLimits: {},
    managerId: "mem_1",
    voice: { ...POLITE_VOICE, forbidden: [...POLITE_VOICE.forbidden] },
    projectAccess: { mode: "company", projectIds: [] },
    postingAs: "bot",
    credentialId: "cred_sns",
    createdAt: new Date(Date.now() - 43200000).toISOString(),
  },
];

export const DEMO_APPROVALS: ApprovalRequest[] = [
  {
    id: "apr_1",
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    title: "承認依頼: mail.send（sales.outreach）",
    purpose: "sales.outreach",
    summary:
      "営業AI社員 が「mail.send」の実行承認を求めています。\n" +
      "目的: sales.outreach\n" +
      "ジョブID: job_demo_mail_outreach_1\n" +
      "リスク: high\n" +
      "内容: 顧客A向け見積フォローメールの外部送信（下書き済み）。\n" +
      "Staffpass 承認後にのみ confirm/send/order を完了できます。未承認のまま確定しないでください。",
    risk: "high",
    status: "pending",
    tool: "mail.send",
    jobId: "job_demo_mail_outreach_1",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: "demoapr00001",
    telegramMessageId: null,
    metadata: {},
    statusToken: "st_demo_apr1_status_token_aaaaaaaa",
    pollPath: buildPollPath("apr_1", "st_demo_apr1_status_token_aaaaaaaa"),
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  },
  {
    id: "apr_2",
    orgId: DEMO_ORG.id,
    employeeId: "emp_ops",
    credentialId: "cred_ops",
    title: "承認依頼: commerce.order（ops.admin）",
    purpose: "ops.admin",
    summary:
      "事務AI社員 が「commerce.order」の実行承認を求めています。\n" +
      "目的: ops.admin\n" +
      "ジョブID: job_demo_order_supplies_1\n" +
      "リスク: high\n" +
      "金額: ¥4,980\n" +
      "内容: デモ用オフィス資材 1件の購入実行（初回発注・人間承認必須）。\n" +
      "Staffpass 承認後にのみ confirm/send/order を完了できます。未承認のまま確定しないでください。",
    risk: "high",
    status: "pending",
    tool: "commerce.order",
    jobId: "job_demo_order_supplies_1",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: "demoapr00002",
    telegramMessageId: null,
    metadata: {},
    statusToken: "st_demo_apr2_status_token_bbbbbbbb",
    pollPath: buildPollPath("apr_2", "st_demo_apr2_status_token_bbbbbbbb"),
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
    jobRole: "owner",
    jobLabel: null,
    capabilities: [
      "view_dashboard",
      "view_employees",
      "view_audit",
      "approve_actions",
      "manage_spend_limits",
      "hire_issue_credentials",
      "manage_team",
      "manage_billing",
    ],
    status: "active",
  },
  {
    id: "mem_2",
    orgId: DEMO_ORG.id,
    email: "sales@example.com",
    displayName: "佐藤 花子",
    role: "admin",
    jobRole: "sales",
    jobLabel: null,
    capabilities: ["view_dashboard", "view_employees", "approve_actions"],
    status: "active",
  },
  {
    id: "mem_3",
    orgId: DEMO_ORG.id,
    email: "accounting@example.com",
    displayName: "鈴木 一郎",
    role: "member",
    jobRole: "accounting",
    jobLabel: null,
    capabilities: [
      "view_dashboard",
      "view_audit",
      "manage_spend_limits",
      "approve_actions",
    ],
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

/** Demo in-memory meter store (gated_confirm_action). */
export type DemoMeterRecord = {
  id: string;
  type: "gated_confirm_action";
  orgId: string;
  employeeId: string;
  tool: string;
  jobId: string;
  billable: boolean;
  purpose?: string | null;
  createdAt: string;
};

const runtimeMeters: DemoMeterRecord[] = [
  // Seed a few so dashboard 「今月の確定アクション」 is non-zero in DEMO.
  {
    id: "mtr_seed_1",
    type: "gated_confirm_action",
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    tool: "mail.send",
    jobId: "job_seed_mail_1",
    billable: true,
    purpose: "sales.outreach",
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
  {
    id: "mtr_seed_2",
    type: "gated_confirm_action",
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    tool: "calendar.confirm",
    jobId: "job_seed_cal_1",
    billable: true,
    purpose: "sales.outreach",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: "mtr_seed_3",
    type: "gated_confirm_action",
    orgId: DEMO_ORG.id,
    employeeId: "emp_ops",
    tool: "commerce.order",
    jobId: "job_seed_order_1",
    billable: true,
    purpose: "ops.admin",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
];
const runtimeMembers: OrgMember[] = DEMO_MEMBERS.map((m) => ({
  ...m,
  capabilities: [...(m.capabilities ?? [])],
}));
let gatewayStatus: GatewayLinkStatus = DEMO_ORG.gatewayStatus;

export function getRuntimeEmployees() {
  return runtimeEmployees;
}

export function getRuntimeMembers() {
  return runtimeMembers;
}

export function getRuntimeMemberById(id: string) {
  return runtimeMembers.find((m) => m.id === id) ?? null;
}

export function upsertRuntimeMember(member: OrgMember) {
  const idx = runtimeMembers.findIndex((m) => m.id === member.id);
  if (idx >= 0) runtimeMembers[idx] = member;
  else runtimeMembers.unshift(member);
  runtimeAudit.unshift({
    id: `aud_${Date.now()}`,
    orgId: DEMO_ORG.id,
    employeeId: null,
    credentialId: null,
    action: "member.invited",
    purpose: null,
    summary: `チーム更新: ${member.displayName}（${member.jobRole ?? member.role}）`,
    metadata: {
      memberId: member.id,
      jobRole: member.jobRole,
      capabilities: member.capabilities ?? [],
    },
    createdAt: new Date().toISOString(),
  });
  return member;
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
      sodLevel: employee.sodLevel,
      actionLimits: employee.actionLimits,
      spend: employee.spend ?? null,
      allowedAccounts: employee.allowedAccounts ?? [],
    },
    createdAt: new Date().toISOString(),
  });
}

export function resolveRuntimeApproval(
  id: string,
  status: "approved" | "rejected" | "revision_requested",
  resolvedBy = "owner@example.com",
  revisionNote?: string
) {
  const idx = runtimeApprovals.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const next = {
    ...runtimeApprovals[idx],
    status,
    revisionNote:
      status === "revision_requested" ? revisionNote?.trim() || null : null,
    revisionCount:
      status === "revision_requested"
        ? runtimeApprovals[idx].revisionCount + 1
        : runtimeApprovals[idx].revisionCount,
    resolvedAt: new Date().toISOString(),
    resolvedBy,
  };
  runtimeApprovals[idx] = next;
  runtimeAudit.unshift({
    id: `aud_${Date.now()}`,
    orgId: DEMO_ORG.id,
    employeeId: next.employeeId,
    credentialId: next.credentialId,
    action:
      status === "revision_requested"
        ? "approval.revision_requested"
        : "approval.resolved",
    purpose: next.purpose,
    summary:
      status === "approved"
        ? `承認: ${next.title || next.summary}`
        : status === "revision_requested"
          ? `修正依頼: ${next.title || next.summary}`
          : `却下: ${next.title || next.summary}`,
    metadata: {
      decision: status,
      resolvedBy,
      tool: next.tool ?? null,
      jobId: next.jobId ?? null,
    },
    createdAt: new Date().toISOString(),
  });
  return next;
}

export type CreateRuntimeApprovalInput = {
  employeeId: string;
  credentialId: string;
  title: string;
  purpose: string;
  summary: string;
  risk: ApprovalRequest["risk"];
  tool?: string | null;
  jobId?: string | null;
  statusToken?: string;
  revisionCount?: number;
  parentApprovalId?: string | null;
  telegramRef?: string;
  metadata?: Record<string, unknown>;
};

export function pushRuntimeApproval(
  input: CreateRuntimeApprovalInput
): ApprovalRequest {
  const id = `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const statusToken = input.statusToken || generateStatusToken();
  const row: ApprovalRequest = {
    id,
    orgId: DEMO_ORG.id,
    employeeId: input.employeeId,
    credentialId: input.credentialId,
    title: input.title,
    purpose: input.purpose,
    summary: input.summary,
    risk: input.risk,
    status: "pending",
    tool: input.tool ?? null,
    jobId: input.jobId ?? null,
    revisionNote: null,
    revisionCount: input.revisionCount ?? 0,
    parentApprovalId: input.parentApprovalId ?? null,
    telegramRef: input.telegramRef || generateTelegramRef(),
    telegramMessageId: null,
    metadata: input.metadata ?? {},
    statusToken,
    pollPath: buildPollPath(id, statusToken),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
  runtimeApprovals.unshift(row);
  runtimeAudit.unshift({
    id: `aud_${Date.now()}`,
    orgId: DEMO_ORG.id,
    employeeId: row.employeeId,
    credentialId: row.credentialId,
    action: "approval.requested",
    purpose: row.purpose,
    summary: `承認待ち: ${row.title}`,
    metadata: {
      approvalId: row.id,
      tool: row.tool,
      jobId: row.jobId,
      risk: row.risk,
      pollPath: row.pollPath,
    },
    createdAt: new Date().toISOString(),
  });
  return row;
}


export function getRuntimeMeterRecords() {
  return runtimeMeters;
}

export function pushRuntimeMeterRecord(
  record: Omit<DemoMeterRecord, "id"> & { id?: string }
): DemoMeterRecord {
  const stored: DemoMeterRecord = {
    id: record.id || `mtr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: "gated_confirm_action",
    orgId: record.orgId,
    employeeId: record.employeeId,
    tool: record.tool,
    jobId: record.jobId,
    billable: record.billable,
    purpose: record.purpose ?? null,
    createdAt: record.createdAt || new Date().toISOString(),
  };
  runtimeMeters.unshift(stored);
  return stored;
}

export function pushRuntimeAuditEvent(
  event: Omit<AuditEvent, "id" | "createdAt"> & { createdAt?: string }
): AuditEvent {
  const row: AuditEvent = {
    id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    orgId: event.orgId,
    employeeId: event.employeeId,
    credentialId: event.credentialId,
    action: event.action,
    purpose: event.purpose,
    summary: event.summary,
    metadata: event.metadata ?? {},
    createdAt: event.createdAt || new Date().toISOString(),
  };
  runtimeAudit.unshift(row);
  return row;
}

// DEMO: seed durable bindings for sample employees (in-memory; labeled DEMO).
seedDemoBindings(
  runtimeEmployees.map((e) => ({ id: e.id, orgId: e.orgId })),
  { linkSales: true }
);

export { countNeedsReauth, listBindingsForOrg, getBinding } from "./bindings";
