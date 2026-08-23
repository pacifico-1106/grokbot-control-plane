/** Domain types for AI社員 control plane (Grok Bot) */

export type IntegrationMode = "managed" | "byo";

export type GatewayLinkStatus = "linked" | "pending" | "disconnected";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalPolicy = "auto" | "always_human" | "risk_based";

/** Per-employee purchase limits (JPY). Fail-closed when order scope present but limits missing. */
export interface SpendLimits {
  /** 0 = 発注禁止（自動不可）。未設定扱いは evaluateSpend 側で needs_approval。 */
  maxPerOrderJpy: number;
  maxPerDayJpy?: number | null;
  maxPerMonthJpy?: number | null;
  /** Free-text tip e.g. "eSIMのみ" / merchant allow hint */
  merchantAllowTip?: string | null;
  /** 初回発注は必ず人間承認（default true） */
  firstOrderRequiresHuman?: boolean;
}

/** External account the AI employee may use (browser / SNS / SaaS). Flexible — not Google-only. */
export interface AllowedAccount {
  /** Free text OR preset key (google, microsoft365, line, x, instagram, facebook, slack, custom, …). */
  service: string;
  /** Email, @handle, page id, etc. */
  accountId: string;
  label?: string;
  /** Hint that browser session must match this identity. */
  browserRequired?: boolean;
}

export type OrgMemberRole = "owner" | "admin" | "member";

/** JP SME job role presets for human team members (not AI employees). */
export type HumanJobRole =
  | "owner"
  | "sales"
  | "accounting"
  | "admin_affairs"
  | "legal"
  | "ops_ai"
  | "custom";

/** Fine-grained human capabilities (beyond coarse owner/admin). */
export type HumanCapability =
  | "view_dashboard"
  | "view_employees"
  | "view_audit"
  | "approve_actions"
  | "manage_spend_limits"
  | "hire_issue_credentials"
  | "manage_team"
  | "manage_billing";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "unpaid";

/** Grok Bot–oriented scopes (not Sealith transfer scopes). */
export type EmployeeScope =
  | "tools:read"
  | "tools:invoke"
  | "mail:draft"
  | "mail:send"
  | "calendar:propose"
  | "calendar:confirm"
  | "files:read"
  | "files:write"
  | "browser:use"
  | "commerce:quote"
  | "commerce:order"
  | "audit:append"
  | "approvals:request";

/**
 * Email channel layers — never mix (Ando §2 / Kimura P0).
 * - human_gmail: 人間の Workspace / Gmail（原則エージェント直操作しない）
 * - agentmail: AI社員専用 inbox（P0.5 スキーマ/ポリシー予約・本送信は P1）
 * - staffpass_resend: 制御面システム通知（歓迎・承認依頼・トライアル）
 */
export type EmailLayer = "human_gmail" | "agentmail" | "staffpass_resend";

/** P0.5 reservation only — no live AgentMail SDK wiring in P0. */
export interface AgentMailReservation {
  employeeId: string;
  orgId: string;
  /** Future inbox id from AgentMail provider */
  inboxId: string | null;
  status: "reserved" | "provisioning" | "active" | "disabled";
  layer: "agentmail";
}

/** Gateway invoke body (fail-closed contract). */
export interface GatewayInvokeRequest {
  employeeId?: string;
  tool: string;
  /** Required — job purpose key (must be in credential.allowedPurposes when set). */
  purpose: string;
  /** Required — correlation id (camelCase or job_id). */
  jobId?: string;
  job_id?: string;
  amountJpy?: number;
  isFirstOrder?: boolean;
  spentTodayJpy?: number;
  spentThisMonthJpy?: number;
  args?: Record<string, unknown>;
}

export type AuditAction =
  | "credential.issued"
  | "credential.revoked"
  | "tool.invoke"
  | "approval.requested"
  | "approval.resolved"
  | "billing.updated"
  | "email.sent"
  | "gateway.link_changed"
  | "employee.created"
  | "employee.updated"
  | "member.invited";

export interface Org {
  id: string;
  name: string;
  integrationMode: IntegrationMode;
  gatewayStatus: GatewayLinkStatus;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  createdAt: string;
}

export interface OrgMember {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  /** Coarse org seat (legacy Stripe/Auth mapping). */
  role: OrgMemberRole;
  /** SME 職務プリセット（営業・経理など）。 */
  jobRole?: HumanJobRole;
  /** jobRole=custom のときの自由ラベル。 */
  jobLabel?: string | null;
  /** 権限フラグ（職務パックから編集可）。 */
  capabilities?: HumanCapability[];
  status: "active" | "invited" | "disabled";
}

/** Product alias — human team member with job role + capability flags. */
export type HumanMember = OrgMember;

export interface Employee {
  id: string;
  orgId: string;
  displayName: string;
  roleLabel: string;
  jobDescription: string;
  status: "active" | "suspended" | "draft";
  scopes: EmployeeScope[];
  allowedPurposes: string[];
  approvalPolicy: ApprovalPolicy;
  /** Purchase budget / risk limits (optional until commerce:order). */
  spend?: SpendLimits | null;
  /** External accounts engraved on the employee badge (shared-PC safe IDs). */
  allowedAccounts?: AllowedAccount[];
  credentialId: string | null;
  createdAt: string;
}

export interface Credential {
  id: string;
  orgId: string;
  employeeId: string;
  scopes: EmployeeScope[];
  allowedPurposes: string[];
  approvalPolicy: ApprovalPolicy;
  spend?: SpendLimits | null;
  allowedAccounts?: AllowedAccount[];
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  orgId: string;
  employeeId: string;
  credentialId: string;
  purpose: string;
  summary: string;
  risk: "low" | "medium" | "high";
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface AuditEvent {
  id: string;
  orgId: string;
  employeeId: string | null;
  credentialId: string | null;
  action: AuditAction;
  purpose: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Subscription {
  id: string;
  orgId: string;
  planKey: "starter" | "business" | "enterprise";
  status: SubscriptionStatus;
  stripeSubscriptionId: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

export interface BillingPlan {
  id: "starter" | "business" | "enterprise";
  nameJa: string;
  trialDays: number;
  paymentMethods: Array<"card" | "customer_balance">;
}

export interface EmployeePolicyDraft {
  policy: {
    displayName: string;
    roleLabel: string;
    scopes: EmployeeScope[];
    allowedPurposes: string[];
    approvalPolicy: ApprovalPolicy;
    expiresInDays: number;
    spend?: SpendLimits | null;
    /** Soft recommendation shown in hire step 3 (not forced). */
    spendRecommendation?: string | null;
    /** Suggested / configured external accounts (Google, SNS, etc.). */
    allowedAccounts?: AllowedAccount[];
    /**
     * Per-tool approval hints from JP SME strict presets (Ando §3).
     * Distinct from human RBAC (OrgMember.capabilities).
     */
    toolApprovalDefaults?: Record<string, ApprovalPolicy | "deny">;
  };
  assumptions: string[];
  missingFields: Array<"role" | "purpose" | "risk" | "scope">;
  warnings: Array<
    | "broad_purpose_access"
    | "mail_send_requested"
    | "calendar_confirm_requested"
    | "commerce_order_requested"
    | "browser_use_requested"
    | "always_human_recommended"
  >;
  confidence: number;
  source: "rules";
}

/** Durable Grok Bot ↔ AI-employee binding status (persisted; not session). */
export type BindingStatus =
  | "unlinked"
  | "linked"
  | "degraded"
  | "needs_reauth"
  | "revoked";

/**
 * Lifeline binding: employeeId is stable forever.
 * Token reissue bumps credentialGeneration only — never resets employeeId.
 */
export interface EmployeeBinding {
  employeeId: string;
  orgId: string;
  grokBotAgentId: string | null;
  grokBotWorkspaceId: string | null;
  credentialGeneration: number;
  /** sha256 stub fingerprint of current credential material (never raw secret). */
  credentialFingerprint: string | null;
  status: BindingStatus;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExecutableDenyCode =
  | "unbound"
  | "revoked"
  | "needs_reauth"
  | "degraded"
  | "health_failed"
  | "not_found";

export interface ExecutableDeny {
  ok: false;
  code: ExecutableDenyCode;
  message: string;
}

export interface ExecutableAllow {
  ok: true;
  binding: EmployeeBinding;
}
