/** Domain types for AI社員 control plane */

export type IntegrationMode = "managed" | "byo";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type AuditAction =
  | "credential.issued"
  | "credential.revoked"
  | "tool.invoke"
  | "approval.requested"
  | "approval.resolved"
  | "billing.updated"
  | "email.sent";

export interface Org {
  id: string;
  name: string;
  integrationMode: IntegrationMode;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  createdAt: string;
}

export interface Employee {
  id: string;
  orgId: string;
  displayName: string;
  roleLabel: string;
  status: "active" | "suspended";
}

export interface Credential {
  id: string;
  orgId: string;
  employeeId: string;
  scopes: string[];
  allowedPurposes: string[];
  approvalPolicy: "auto" | "always_human" | "risk_based";
  expiresAt: string | null;
  revokedAt: string | null;
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

export interface BillingPlan {
  id: "starter" | "business" | "enterprise";
  nameJa: string;
  trialDays: number;
  /** JP: card + bank transfer (customer_balance) documented */
  paymentMethods: Array<"card" | "customer_balance">;
}
