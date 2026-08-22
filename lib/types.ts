/** Domain types for AI社員 control plane (Grok Bot) */

export type IntegrationMode = "managed" | "byo";

export type GatewayLinkStatus = "linked" | "pending" | "disconnected";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalPolicy = "auto" | "always_human" | "risk_based";

export type OrgMemberRole = "owner" | "admin" | "member";

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
  | "files:read"
  | "files:write"
  | "browser:use"
  | "commerce:quote"
  | "commerce:order"
  | "audit:append"
  | "approvals:request";

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
  role: OrgMemberRole;
  status: "active" | "invited" | "disabled";
}

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
  };
  assumptions: string[];
  missingFields: Array<"role" | "purpose" | "risk" | "scope">;
  warnings: Array<
    | "broad_purpose_access"
    | "mail_send_requested"
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
