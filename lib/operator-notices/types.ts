/**
 * Operator notices (運営からのお知らせ) — in-memory / mapped row types.
 * Publishing is operator-only (Web, later PR). This module never takes org /
 * employee from the client: callers pass the badge's orgId + employeeId.
 */

export const NOTICE_STATUSES = ["draft", "published", "withdrawn"] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const NOTICE_SEVERITIES = ["info", "normal", "important", "urgent"] as const;
export type NoticeSeverity = (typeof NOTICE_SEVERITIES)[number];

export const NOTICE_AUDIENCE_SCOPES = ["all", "orgs", "employees"] as const;
export type NoticeAudienceScope = (typeof NOTICE_AUDIENCE_SCOPES)[number];

/** Wire value for AI employees: never leak who else is in the audience. */
export const NOTICE_AUDIENCE_WIRE = ["all", "org", "employee"] as const;
export type NoticeAudienceWire = (typeof NOTICE_AUDIENCE_WIRE)[number];

export const NOTICE_APPLY_MODES = ["none", "self_rules", "instructions_via_approval"] as const;
export type NoticeApplyMode = (typeof NOTICE_APPLY_MODES)[number];

export const NOTICE_VERSION_KINDS = ["initial", "correction", "minor"] as const;
export type NoticeVersionKind = (typeof NOTICE_VERSION_KINDS)[number];

export const NOTICE_RECEIPT_STATES = [
  "delivered",
  "read",
  "applied",
  "not_applicable",
  "needs_tenant_approval",
  "declined",
] as const;
export type NoticeReceiptState = (typeof NOTICE_RECEIPT_STATES)[number];

export const NOTICE_APPLY_EVIDENCE = ["self_reported", "config_change_applied"] as const;
export type NoticeApplyEvidence = (typeof NOTICE_APPLY_EVIDENCE)[number];

export const NOTICE_WAKE_STATES = ["none", "pending", "delivered", "failed"] as const;
export type NoticeWakeState = (typeof NOTICE_WAKE_STATES)[number];

export const TITLE_MAX = 120;
export const CHANGE_SUMMARY_MAX = 4000;
export const AI_USAGE_CHANGE_MAX = 4000;
export const BODY_FIELDS_COMBINED_MAX = 8000;
export const CHANGE_NOTE_MAX = 500;
export const RECEIPT_NOTE_MAX = 500;
export const RELATED_FLAGS_MAX = 10;
export const LIST_DEFAULT_LIMIT = 5;
export const LIST_MAX_LIMIT = 10;
export const LIST_MAX_CHARS = 40_000;

export type OperatorNotice = {
  id: string;
  seq: number;
  version: number;
  status: NoticeStatus;
  severity: NoticeSeverity;
  title: string;
  changeSummary: string;
  aiUsageChange: string;
  effectiveAt: string;
  expiresAt: string | null;
  audienceScope: NoticeAudienceScope;
  sticky: boolean;
  relatedFlags: string[];
  applyMode: NoticeApplyMode;
  showToTenantAdmin: boolean;
  relatesToItemIds: string[];
  bodyHash: string;
  createdByUserId: string | null;
  createdByEmail: string | null;
  publishedByUserId: string | null;
  publishedByEmail: string | null;
  createdAt: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
  updatedAt: string;
};

export type OperatorNoticeTarget = {
  noticeId: string;
  orgId: string;
  employeeId: string | null;
};

export type OperatorNoticeVersion = {
  noticeId: string;
  version: number;
  kind: NoticeVersionKind;
  changeNote: string | null;
  title: string;
  changeSummary: string;
  aiUsageChange: string;
  bodyHash: string;
  createdByUserId: string | null;
  createdAt: string;
};

export type OperatorNoticeReceipt = {
  noticeId: string;
  orgId: string;
  employeeId: string;
  firstListedAt: string;
  readAt: string | null;
  readVersion: number | null;
  state: NoticeReceiptState;
  ackedVersion: number | null;
  ackedAt: string | null;
  applyEvidence: NoticeApplyEvidence | null;
  configChangeApprovalId: string | null;
  note: string | null;
  wakeState: NoticeWakeState;
  updatedAt: string;
};

export type NoticeTargetPicker = {
  orgs: { id: string; name: string }[];
  employees: { id: string; orgId: string; name: string }[];
};

export type VisibilityContext = {
  orgId: string;
  employeeId: string;
  /** orgs.created_at — never a client argument; looked up from the org row. */
  orgCreatedAt: string;
  now?: Date;
};

export function audienceScopeToWire(scope: NoticeAudienceScope): NoticeAudienceWire {
  if (scope === "orgs") return "org";
  if (scope === "employees") return "employee";
  return "all";
}

export function isNoticeStatus(v: string): v is NoticeStatus {
  return (NOTICE_STATUSES as readonly string[]).includes(v);
}
export function isNoticeSeverity(v: string): v is NoticeSeverity {
  return (NOTICE_SEVERITIES as readonly string[]).includes(v);
}
export function isNoticeAudienceScope(v: string): v is NoticeAudienceScope {
  return (NOTICE_AUDIENCE_SCOPES as readonly string[]).includes(v);
}
export function isNoticeApplyMode(v: string): v is NoticeApplyMode {
  return (NOTICE_APPLY_MODES as readonly string[]).includes(v);
}
export function isNoticeReceiptState(v: string): v is NoticeReceiptState {
  return (NOTICE_RECEIPT_STATES as readonly string[]).includes(v);
}
