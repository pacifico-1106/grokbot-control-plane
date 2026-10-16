/** Read-model for /app/audit. Never include raw metadata / secrets / full emails. */

export type ActorKind = "ai" | "human" | "system";

export type AuditResultKind = "success" | "failure" | "denied" | "pending" | "unknown";

export type AuditApprovalStatus =
  | "none"
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "revision_requested"
  | "unknown";

export type AuditTargetKind =
  | "slack_channel"
  | "slack_user"
  | "email"
  | "employee"
  | "member"
  | "sns"
  | "other"
  | "none";

export type AuditActorView = {
  kind: ActorKind;
  /** Never blank. */
  name: string;
  emailMasked: string | null;
  employeeId: string | null;
};

export type AuditActionView = {
  id: string;
  labelJa: string;
};

export type AuditTargetView = {
  kind: AuditTargetKind;
  labelJa: string;
  /** Drawer only. List must not render this. */
  rawId: string | null;
};

export type AuditApprovalView = {
  needed: boolean | null;
  approvalId: string | null;
  status: AuditApprovalStatus;
  approverName: string | null;
  approverEmailMasked: string | null;
};

export type AuditResultView = {
  kind: AuditResultKind;
  reasonCode: string | null;
  reasonJa: string | null;
};

/** Safe keys only. Never pollPath / statusToken / payload / destination email. */
export type AuditSafeMeta = {
  purpose: string | null;
  jobId: string | null;
  risk: string | null;
  informationClass: string | null;
  audience: string | null;
  approvalIdPrefix: string | null;
};

export type AuditRowView = {
  id: string;
  createdAt: string;
  createdAtJst: string;
  createdAtJstPrecise: string;
  actor: AuditActorView;
  action: AuditActionView;
  target: AuditTargetView;
  summary: string;
  summaryDetail: string;
  approval: AuditApprovalView;
  result: AuditResultView;
  safeMeta: AuditSafeMeta;
};

export type AuditEmployeeLookup = {
  displayName?: string | null;
};

export type AuditMemberLookup = {
  displayName: string;
  email: string;
};

export type AuditApprovalLookup = {
  id: string;
  orgId: string;
  status: string;
  resolvedBy: string | null;
  employeeId: string | null;
  jobId: string | null;
};

export type AuditPresentationLookups = {
  orgId?: string | null;
  employeesById?: ReadonlyMap<string, AuditEmployeeLookup>;
  membersByEmail?: ReadonlyMap<string, AuditMemberLookup>;
  mailboxEmailByEmployeeId?: ReadonlyMap<string, string>;
  slackDisplayNameByUserId?: ReadonlyMap<string, string>;
  approvalsById?: ReadonlyMap<string, AuditApprovalLookup>;
  approvalsByJobEmployee?: ReadonlyMap<string, readonly AuditApprovalLookup[]>;
};
