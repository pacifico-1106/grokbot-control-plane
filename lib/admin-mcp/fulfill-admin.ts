/**
 * Fulfill admin MCP tickets after a different human approves.
 * Uses the existing issueEmployee / linkAgent / updateEmployeePolicy /
 * upsertOrgParty / upsertOrgChannel paths — no second mutation skip.
 */
import { createHash, randomBytes } from "node:crypto";
import { normalizeActionLimits } from "@/lib/action-gate";
import { appendAuditEvent, issueEmployee, updateEmployeePolicy } from "@/lib/data";
import { updateApprovalMetadata } from "@/lib/data/approvals";
import { linkAgent } from "@/lib/data/bindings";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { normalizeApproverUserIds } from "@/lib/employees/approval-inbox";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { defaultProjectAccess, normalizeProjectAccess } from "@/lib/employees/project-access";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import { defaultVoice, normalizeVoice } from "@/lib/employees/voice";
import { normalizeSpendLimits } from "@/lib/spend-gate";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { ADMIN_AUDIT_CLASS, auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import type {
  ActionLimits,
  AllowedAccount,
  ApprovalPolicy,
  ApprovalRequest,
  ChannelClassification,
  ConversationSurface,
  EmployeeScope,
  OrgPartyKind,
  SpendLimits,
} from "@/lib/types";

export type AdminFulfillment = {
  ok: boolean;
  tool: string;
  at: string;
  error?: string;
  employeeId?: string;
  secretPrefix?: string;
  /** Present once after hire fulfill; stripped after first read. */
  oneTimeSecret?: string;
  partyId?: string;
  channelId?: string;
  draft?: unknown;
  nextStepJa?: string;
  noticeJa?: string;
};

const TOOL_NEXTSTEP_JA: Record<string, string> = {
  "employees.issue":
    "次は手足をこの社員証につなぎます。Grok Botを1体用意して、管理MCPの link に grokBotAgentId を渡してください。人がやるのは承認タップだけです。社員証の秘密はチャットに貼らない。",
};

const TOOL_NOTICE_JA: Record<string, string> = {
  link: "紐付け完了。次はコネクタ認証（OAuthは人がタップ、承認チケットとは別）。",
};

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function issueSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `gb_emp_${randomBytes(8).toString("hex")}_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 14) };
}

function asScopes(value: unknown): EmployeeScope[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter((scope) => ALL_SCOPES.includes(scope as EmployeeScope)) as EmployeeScope[];
}

async function persist(approval: ApprovalRequest, fulfillment: AdminFulfillment): Promise<void> {
  const saved = await updateApprovalMetadata(approval, {
    fulfillment,
    adminFulfillment: fulfillment,
  });
  approval.metadata = saved ? saved.metadata : { ...approval.metadata, fulfillment };
}

export function parseAdminFulfillment(
  metadata: Record<string, unknown> | null | undefined
): AdminFulfillment | null {
  const raw = metadata?.adminFulfillment ?? metadata?.fulfillment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") return null;
  return {
    ok: rec.ok,
    tool: typeof rec.tool === "string" ? rec.tool : "",
    at: typeof rec.at === "string" ? rec.at : new Date().toISOString(),
    error: typeof rec.error === "string" ? rec.error : undefined,
    employeeId: typeof rec.employeeId === "string" ? rec.employeeId : undefined,
    secretPrefix: typeof rec.secretPrefix === "string" ? rec.secretPrefix : undefined,
    oneTimeSecret: typeof rec.oneTimeSecret === "string" ? rec.oneTimeSecret : undefined,
    partyId: typeof rec.partyId === "string" ? rec.partyId : undefined,
    channelId: typeof rec.channelId === "string" ? rec.channelId : undefined,
    draft: rec.draft,
    nextStepJa: typeof rec.nextStepJa === "string" ? rec.nextStepJa : undefined,
    noticeJa: typeof rec.noticeJa === "string" ? rec.noticeJa : undefined,
  };
}

async function fulfillIssue(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const displayName = String(args.displayName || "").trim();
  const roleLabel = String(args.roleLabel || "").trim();
  const scopes = asScopes(args.scopes);
  if (!displayName || !roleLabel || !scopes.length) {
    throw new Error("invalid_issue_payload");
  }
  const secret = issueSecret();
  const expiresInDays = Math.min(365, Math.max(1, Number(args.expiresInDays) || 30));
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const hasOrder = scopes.includes("commerce:order");
  const spend = hasOrder
    ? normalizeSpendLimits((args.spend as Partial<SpendLimits> | null) ?? {})
    : null;
  const result = await issueEmployee({
    orgId: approval.orgId,
    displayName,
    roleLabel,
    jobDescription: String(args.jobDescription || ""),
    scopes,
    allowedPurposes: Array.isArray(args.allowedPurposes)
      ? args.allowedPurposes.map(String).filter(Boolean)
      : [],
    approvalPolicy: (args.approvalPolicy as ApprovalPolicy) || "risk_based",
    toolApprovalDefaults: normalizeToolApprovalDefaults(args.toolApprovalDefaults),
    sodOverrideAcknowledged: args.sodOverrideAcknowledged === true,
    actionLimits: normalizeActionLimits(args.actionLimits as ActionLimits),
    spend,
    allowedAccounts: normalizeAllowedAccounts(
      Array.isArray(args.allowedAccounts) ? (args.allowedAccounts as AllowedAccount[]) : []
    ),
    approvalNotifyEmail: typeof args.approvalNotifyEmail === "string" ? args.approvalNotifyEmail : null,
    callbackUrl: typeof args.callbackUrl === "string" ? args.callbackUrl : null,
    managerId: typeof args.managerId === "string" ? args.managerId : null,
    voice: args.voice == null ? defaultVoice() : normalizeVoice(args.voice),
    projectAccess:
      args.projectAccess == null
        ? defaultProjectAccess()
        : normalizeProjectAccess(args.projectAccess),
    postingAs: normalizePostingAs(args.postingAs),
    approvalChannelId: typeof args.approvalChannelId === "string" ? args.approvalChannelId : null,
    approverUserIds: normalizeApproverUserIds(args.approverUserIds),
    secretHash: secret.hash,
    secretPrefix: secret.prefix,
    expiresAt,
    auditSummary: `${displayName} の社員証を発行（管理MCP・人承認後）`,
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: result.employee.id,
    credentialId: result.credentialId,
    action: "admin.hire",
    purpose: "admin.hire",
    summary: `${displayName} を人確認のうえで発行`,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id },
  });
  return {
    ok: true,
    tool: "employees.issue",
    at: new Date().toISOString(),
    employeeId: result.employee.id,
    secretPrefix: secret.prefix,
    oneTimeSecret: secret.raw,
    nextStepJa: TOOL_NEXTSTEP_JA["employees.issue"],
  };
}

async function fulfillLink(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const employeeId = String(args.employeeId || "").trim();
  const grokBotAgentId = String(args.grokBotAgentId || "").trim();
  if (!employeeId || !grokBotAgentId) throw new Error("invalid_link_payload");
  const binding = await linkAgent(employeeId, {
    orgId: approval.orgId,
    grokBotAgentId,
    grokBotWorkspaceId: typeof args.grokBotWorkspaceId === "string" ? args.grokBotWorkspaceId : null,
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId,
    credentialId: null,
    action: "admin.link",
    purpose: "admin.link",
    summary: "Grok Bot エージェントを連携（人承認後）",
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      grokBotAgentId: binding.grokBotAgentId,
    },
  });
  return {
    ok: true,
    tool: "link",
    at: new Date().toISOString(),
    employeeId,
    noticeJa: TOOL_NOTICE_JA.link,
  };
}

async function fulfillPolicy(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const employeeId = String(args.employeeId || "").trim();
  const scopes = asScopes(args.scopes);
  const approvalPolicy = args.approvalPolicy as ApprovalPolicy;
  if (!employeeId || !scopes.length || !["auto", "risk_based", "always_human"].includes(approvalPolicy)) {
    throw new Error("invalid_policy_payload");
  }
  const updated = await updateEmployeePolicy({
    orgId: approval.orgId,
    employeeId,
    scopes,
    allowedPurposes: Array.isArray(args.allowedPurposes)
      ? args.allowedPurposes.map(String).filter(Boolean)
      : [],
    approvalPolicy,
    toolApprovalDefaults:
      args.toolApprovalDefaults !== undefined
        ? normalizeToolApprovalDefaults(args.toolApprovalDefaults)
        : undefined,
    sodOverrideAcknowledged: args.sodOverrideAcknowledged === true,
    actionLimits: normalizeActionLimits(args.actionLimits as ActionLimits),
  });
  if (!updated) throw new Error("employee_not_found");
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId,
    credentialId: updated.credentialId,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `${updated.displayName} の権限を人確認のうえで更新`,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id, scopes: updated.scopes },
  });
  return { ok: true, tool: "policy.patch", at: new Date().toISOString(), employeeId };
}

async function fulfillParty(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const identifier = String(args.identifier || "").trim();
  const kind = String(args.kind || "") as OrgPartyKind;
  if (!identifier) throw new Error("identifier_required");
  const party = await upsertOrgParty({
    orgId: approval.orgId,
    kind,
    identifier,
    audience: args.audience === "internal" ? "internal" : "external",
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.parties",
    purpose: "admin.parties",
    summary: `相手台帳を更新: ${party.identifier}`,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id, partyId: party.id },
  });
  return { ok: true, tool: "parties.upsert", at: new Date().toISOString(), partyId: party.id };
}

async function fulfillChannel(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const externalId = String(args.externalId || args.identifier || "").trim();
  if (!externalId) throw new Error("external_id_required");
  const channel = await upsertOrgChannel({
    orgId: approval.orgId,
    surface: (String(args.surface || "slack") as ConversationSurface),
    externalId,
    classification: (String(args.classification || "unknown") as ChannelClassification),
    mixed: args.mixed === true,
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.channel",
    purpose: "admin.channel",
    summary: `チャネル分類: ${channel.externalId}`,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id, channelId: channel.id },
  });
  return { ok: true, tool: "channels.classify", at: new Date().toISOString(), channelId: channel.id };
}

async function fulfillRolePropose(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const draft = args.draft ?? args.proposedPolicy ?? null;
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.role",
    purpose: "admin.role",
    summary: "職務案を人確認しました（発行は別チケット）",
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id },
  });
  return {
    ok: true,
    tool: "roles.propose",
    at: new Date().toISOString(),
    draft,
  };
}

export async function fulfillApprovedAdmin(
  approval: ApprovalRequest
): Promise<AdminFulfillment | null> {
  if (!isAdminClassApproval(approval)) return null;
  if (approval.status !== "approved") return null;
  const existing = parseAdminFulfillment(approval.metadata);
  if (existing?.ok) return existing;
  const args = rec(approval.metadata?.adminMutation);
  const tool = String(approval.metadata?.adminTool || approval.tool || "");
  const at = new Date().toISOString();
  try {
    let fulfillment: AdminFulfillment;
    switch (tool) {
      case "employees.issue":
        fulfillment = await fulfillIssue(approval, args);
        break;
      case "link":
        fulfillment = await fulfillLink(approval, args);
        break;
      case "policy.patch":
        fulfillment = await fulfillPolicy(approval, args);
        break;
      case "parties.upsert":
        fulfillment = await fulfillParty(approval, args);
        break;
      case "channels.classify":
        fulfillment = await fulfillChannel(approval, args);
        break;
      case "roles.propose":
        fulfillment = await fulfillRolePropose(approval, args);
        break;
      default:
        fulfillment = { ok: false, tool, at, error: "unknown_admin_tool" };
    }
    await persist(approval, fulfillment);
    return fulfillment;
  } catch (error) {
    const message = error instanceof Error ? error.message : "fulfill_failed";
    const fulfillment: AdminFulfillment = { ok: false, tool, at, error: message };
    try {
      await persist(approval, fulfillment);
    } catch {
      approval.metadata = { ...approval.metadata, fulfillment };
    }
    return fulfillment;
  }
}

export { auditActionForAdminTool };
