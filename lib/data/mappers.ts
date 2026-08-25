import type {
  AllowedAccount,
  ActionLimits,
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
    sodLevel: (row.sod_level as Employee["sodLevel"]) || "ok",
    actionLimits: (row.action_limits as ActionLimits) || {},
    spend: (row.spend as SpendLimits | null) ?? null,
    allowedAccounts: (row.allowed_accounts as AllowedAccount[]) || [],
    approvalNotifyEmail:
      row.approval_notify_email != null && String(row.approval_notify_email).trim()
        ? String(row.approval_notify_email).trim()
        : null,
    callbackUrl:
      row.callback_url != null && String(row.callback_url).trim()
        ? String(row.callback_url).trim()
        : null,
    approvalRoutineText:
      row.approval_routine_text != null && String(row.approval_routine_text).trim()
        ? String(row.approval_routine_text)
        : null,
    credentialId: row.credential_id != null ? String(row.credential_id) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

export function mapApprovalRow(row: Record<string, unknown>): ApprovalRequest {
  const meta =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
  const id = String(row.id);
  const statusToken = String(
    row.status_token ?? meta.statusToken ?? meta.status_token ?? ""
  );
  const pollPath = String(
    row.poll_path ??
      meta.pollPath ??
      meta.poll_path ??
      (statusToken ? `/api/approvals/status?id=${encodeURIComponent(id)}&token=${encodeURIComponent(statusToken)}` : "")
  );
  const title = String(
    row.title ?? meta.title ?? row.summary ?? "承認依頼"
  );
  const revisionCount = Number(
    row.revision_count ?? meta.revisionCount ?? meta.revision_count ?? 0
  );
  const telegramMessageId = Number(
    row.telegram_message_id ?? meta.telegramMessageId ?? Number.NaN
  );
  return {
    id,
    orgId: String(row.org_id),
    employeeId: String(row.employee_id),
    credentialId: String(row.credential_id),
    title,
    purpose: String(row.purpose ?? ""),
    summary: String(row.summary ?? ""),
    risk: (row.risk as ApprovalRequest["risk"]) || "medium",
    status: (row.status as ApprovalRequest["status"]) || "pending",
    tool:
      row.tool != null
        ? String(row.tool)
        : meta.tool != null
          ? String(meta.tool)
          : null,
    jobId:
      row.job_id != null
        ? String(row.job_id)
        : meta.jobId != null
          ? String(meta.jobId)
          : meta.job_id != null
            ? String(meta.job_id)
            : null,
    revisionNote:
      row.revision_note != null
        ? String(row.revision_note)
        : meta.revisionNote != null
          ? String(meta.revisionNote)
          : null,
    revisionCount:
      Number.isFinite(revisionCount) && revisionCount >= 0 ? revisionCount : 0,
    parentApprovalId:
      row.parent_approval_id != null
        ? String(row.parent_approval_id)
        : meta.parentApprovalId != null
          ? String(meta.parentApprovalId)
          : null,
    telegramRef:
      row.telegram_ref != null
        ? String(row.telegram_ref)
        : meta.telegramRef != null
          ? String(meta.telegramRef)
          : null,
    telegramMessageId: Number.isSafeInteger(telegramMessageId)
      ? telegramMessageId
      : null,
    metadata: meta,
    statusToken,
    pollPath,
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
  referralCode: string | null;
};

export function mapOrgRow(row: Record<string, unknown>): OrgMeta {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    integrationMode: (row.integration_mode as "managed" | "byo") || "managed",
    gatewayStatus: (row.gateway_status as GatewayLinkStatus) || "pending",
    trialEndsAt: row.trial_ends_at != null ? String(row.trial_ends_at) : null,
    referralCode:
      row.referral_code != null && String(row.referral_code).trim()
        ? String(row.referral_code).trim()
        : null,
  };
}


export function mapSubscriptionRow(row: Record<string, unknown>): Subscription {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    planKey: (() => {
      const raw = String(row.plan_key || "business").toLowerCase();
      if (raw === "starter" || raw === "business" || raw === "managed") {
        return raw as Subscription["planKey"];
      }
      if (raw === "enterprise") return "managed";
      return "business";
    })(),
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
