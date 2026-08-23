import type {
  AllowedAccount,
  ApprovalPolicy,
  ApprovalRequest,
  AuditAction,
  AuditEvent,
  BindingStatus,
  Employee,
  EmployeeBinding,
  EmployeeScope,
  GatewayLinkStatus,
  HumanCapability,
  HumanJobRole,
  OrgMember,
  OrgMemberRole,
  SpendLimits,
  Subscription,
  SubscriptionStatus,
} from "../types";

export function mapEmployeeRow(row: Record<string, unknown>): Employee {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    displayName: String(row.display_name ?? ""),
    roleLabel: String(row.role_label ?? ""),
    jobDescription: String(row.job_description ?? ""),
    status: (row.status as Employee["status"]) || "active",
    scopes: (row.scopes as EmployeeScope[]) || [],
    allowedPurposes: (row.allowed_purposes as string[]) || [],
    approvalPolicy: (row.approval_policy as ApprovalPolicy) || "risk_based",
    spend: (row.spend as SpendLimits | null) ?? null,
    allowedAccounts: (row.allowed_accounts as AllowedAccount[]) || [],
    credentialId: row.credential_id != null ? String(row.credential_id) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

export function mapApprovalRow(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    employeeId: String(row.employee_id),
    credentialId: String(row.credential_id),
    purpose: String(row.purpose ?? ""),
    summary: String(row.summary ?? ""),
    risk: (row.risk as ApprovalRequest["risk"]) || "medium",
    status: (row.status as ApprovalRequest["status"]) || "pending",
    createdAt: String(row.created_at ?? new Date().toISOString()),
    resolvedAt: row.resolved_at != null ? String(row.resolved_at) : null,
    resolvedBy: row.resolved_by != null ? String(row.resolved_by) : null,
  };
}

export function mapAuditRow(row: Record<string, unknown>): AuditEvent {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    employeeId: row.employee_id != null ? String(row.employee_id) : null,
    credentialId: row.credential_id != null ? String(row.credential_id) : null,
    action: (row.action as AuditAction) || "tool.invoke",
    purpose: row.purpose != null ? String(row.purpose) : null,
    summary: String(row.summary ?? ""),
    metadata: (row.metadata as Record<string, unknown>) || {},
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

export function mapMemberRow(row: Record<string, unknown>): OrgMember {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    email: String(row.email ?? ""),
    displayName: String(row.display_name ?? ""),
    role: (row.role as OrgMemberRole) || "member",
    jobRole: (row.job_role as HumanJobRole) || "custom",
    jobLabel: row.job_label != null ? String(row.job_label) : null,
    capabilities: (row.capabilities as HumanCapability[]) || [],
    status: (row.status as OrgMember["status"]) || "active",
  };
}

export function mapBindingRow(row: Record<string, unknown>): EmployeeBinding {
  return {
    employeeId: String(row.employee_id),
    orgId: String(row.org_id),
    grokBotAgentId:
      row.grok_bot_agent_id != null ? String(row.grok_bot_agent_id) : null,
    grokBotWorkspaceId:
      row.grok_bot_workspace_id != null
        ? String(row.grok_bot_workspace_id)
        : null,
    credentialGeneration: Number(row.credential_generation ?? 0),
    credentialFingerprint:
      row.credential_fingerprint != null
        ? String(row.credential_fingerprint)
        : null,
    status: (row.status as BindingStatus) || "unlinked",
    lastSuccessAt:
      row.last_success_at != null ? String(row.last_success_at) : null,
    lastError: row.last_error != null ? String(row.last_error) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

export type OrgMeta = {
  id: string;
  name: string;
  integrationMode: "managed" | "byo";
  gatewayStatus: GatewayLinkStatus;
  trialEndsAt: string | null;
};

export function mapOrgRow(row: Record<string, unknown>): OrgMeta {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    integrationMode: (row.integration_mode as "managed" | "byo") || "managed",
    gatewayStatus: (row.gateway_status as GatewayLinkStatus) || "pending",
    trialEndsAt: row.trial_ends_at != null ? String(row.trial_ends_at) : null,
  };
}


export function mapSubscriptionRow(row: Record<string, unknown>): Subscription {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    planKey: (row.plan_key as Subscription["planKey"]) || "business",
    status: (row.status as SubscriptionStatus) || "trialing",
    stripeSubscriptionId:
      row.stripe_subscription_id != null
        ? String(row.stripe_subscription_id)
        : null,
    trialEndsAt: row.trial_ends_at != null ? String(row.trial_ends_at) : null,
    currentPeriodEnd:
      row.current_period_end != null ? String(row.current_period_end) : null,
  };
}
