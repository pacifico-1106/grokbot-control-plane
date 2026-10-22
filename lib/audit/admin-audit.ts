/**
 * Required identity on every admin.* audit write.
 * Human tap → actor_email + actorKind=human.
 * Admin AI key (gb_adm_) → metadata.adminAgentId + generation + actorKind=admin_agent
 * (flag OFF). With ADMIN_AUDIT_WHO_REQUIRED_ENABLED, admin_agent / cron / webhook
 * / system paths write actorKind=system + actorLabel. Never fabricate an email.
 * Never persist secrets, full hashes, or full secret prefixes.
 */
import { parseAdminRequester } from "@/lib/admin-mcp/self-approval";
import { extractEmail, isEmailLike } from "@/lib/audit/mask";
import { AUDIT_REASON_JA } from "@/lib/audit/result";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  isAdminAuditSixFieldWriteEnabledForOrg,
  isAdminAuditWhoRequiredEnabledForOrg,
} from "@/lib/feature-flags";
import type { AuditAction, AuditEvent } from "@/lib/types";

export type AdminAuditActorKind = "human" | "admin_agent" | "system";

export type HumanAdminAuditActor = {
  actorKind: "human";
  actorEmail: string;
  actorMemberId?: string | null;
};

export type AdminAgentAuditActor = {
  actorKind: "admin_agent";
  adminAgentId: string;
  generation: number;
  /** Human approver email when this write follows an approved ticket. */
  actorEmail?: string | null;
};

export type SystemAdminAuditActor = {
  actorKind: "system";
  actorLabel: string;
  adminAgentId?: string;
  generation?: number;
};

export type AdminAuditActor = HumanAdminAuditActor | AdminAgentAuditActor | SystemAdminAuditActor;

/** Target of an admin.* write: type + id only. No secrets or PII. */
export type AdminAuditTarget = { type: string; id: string };

/** Short reason code plus a Japanese label. No secrets or PII. */
export type AdminAuditReason = { code: string; labelJa: string };

/** Write-side result. UI may map error → failure. */
export type AdminAuditResult = "success" | "denied" | "error" | "pending";

const ADMIN_AUDIT_RESULTS = new Set<AdminAuditResult>(["success", "denied", "error", "pending"]);
const REASON_CODE_RE = /^[a-z][a-z0-9._-]{0,63}$/i;
const MAX_TARGET_TYPE = 64;
const MAX_TARGET_ID = 128;
const MAX_REASON_LABEL = 80;

/** Short, non-PII labels for system / cron / webhook / admin-agent paths. */
export const ADMIN_AUDIT_SYSTEM_LABEL = {
  adminMcp: "管理MCP",
  ingress: "ingress",
  cardSetup: "カード登録",
  cardPortal: "カードポータル",
  web: "web",
} as const;

const MAX_ACTOR_LABEL = 40;

const SECRET_KEY =
  /^(oneTimeSecret|rawSecret|secret|token|password|bearer|authorization|credential|secretHash|credentialFingerprint|pollUrl|pollPath|poll_path|statusToken|status_token)$/i;
const SECRET_VALUE = /\b(gb_adm_|gb_emp_|sp_at_)[a-zA-Z0-9]{8,}/;
const POLL_URL_RE = /\/api\/approvals\/status\?[^\s"'<>]*token=/i;
const LONG_HEX = /[0-9a-fA-F]{32,}/;
const HASH_KEY = /(hash|fingerprint)/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function humanAdminActor(email: string, memberId?: string | null): HumanAdminAuditActor {
  const actorEmail = email.trim();
  if (!actorEmail) throw new Error("admin_audit_actor_email_required");
  return memberId
    ? { actorKind: "human", actorEmail, actorMemberId: memberId }
    : { actorKind: "human", actorEmail };
}

export function adminAgentAuditActor(adminAgentId: string, generation: number): AdminAgentAuditActor {
  const id = String(adminAgentId ?? "").trim();
  if (!id) throw new Error("admin_audit_adminAgentId_required");
  if (!Number.isFinite(generation)) throw new Error("admin_audit_generation_required");
  return { actorKind: "admin_agent", adminAgentId: id, generation };
}

export function systemAdminActor(
  label: string,
  extras?: { adminAgentId?: string; generation?: number }
): SystemAdminAuditActor {
  const actorLabel = String(label ?? "").trim();
  if (!actorLabel) throw new Error("admin_audit_actorLabel_required");
  if (actorLabel.length > MAX_ACTOR_LABEL) throw new Error("admin_audit_actorLabel_too_long");
  if (actorLabel.includes("@") || isEmailLike(actorLabel)) {
    throw new Error("admin_audit_actorLabel_email_forbidden");
  }
  rejectSecretsInValue(actorLabel, "actorLabel");
  const out: SystemAdminAuditActor = { actorKind: "system", actorLabel };
  const id = extras?.adminAgentId ? String(extras.adminAgentId).trim() : "";
  if (id) out.adminAgentId = id;
  if (extras && Number.isFinite(extras.generation)) out.generation = extras.generation;
  return out;
}

export function adminActorMetadata(actor: AdminAuditActor): Record<string, unknown> {
  if (actor.actorKind === "human") {
    return {
      actorKind: "human" as const,
      ...(actor.actorMemberId ? { actorMemberId: actor.actorMemberId } : {}),
    };
  }
  if (actor.actorKind === "system") {
    return {
      actorKind: "system" as const,
      actorLabel: actor.actorLabel,
      ...(actor.adminAgentId ? { adminAgentId: actor.adminAgentId } : {}),
      ...(Number.isFinite(actor.generation) ? { generation: actor.generation } : {}),
    };
  }
  return {
    actorKind: "admin_agent" as const,
    adminAgentId: actor.adminAgentId,
    generation: actor.generation,
  };
}

export type AdminAuditApprovalRef = {
  metadata?: Record<string, unknown> | null;
  resolvedBy?: string | null;
  approverMemberId?: string | null;
};

export function adminActorFromApproval(approval: AdminAuditApprovalRef): AdminAuditActor {
  const meta = approval.metadata || {};
  const requester = parseAdminRequester(meta);
  if (requester?.actorId) {
    const generation = requester.credentialGeneration;
    if (generation === undefined || !Number.isFinite(generation)) {
      throw new Error("admin_audit_generation_required");
    }
    return withApproverEmail(adminAgentAuditActor(requester.actorId, generation), approval);
  }
  const adminAgentId = typeof meta.adminAgentId === "string" ? meta.adminAgentId.trim() : "";
  if (adminAgentId && Number.isFinite(Number(meta.generation))) {
    return withApproverEmail(adminAgentAuditActor(adminAgentId, Number(meta.generation)), approval);
  }
  const email =
    extractEmail(approval.resolvedBy) ||
    (typeof meta.actorEmail === "string" && meta.actorEmail.trim()) ||
    (typeof meta.platformActorEmail === "string" && meta.platformActorEmail.trim()) ||
    "";
  if (email) {
    const memberId =
      typeof approval.approverMemberId === "string"
        ? approval.approverMemberId
        : typeof meta.actorMemberId === "string"
          ? meta.actorMemberId
          : typeof meta.platformActorUserId === "string"
            ? meta.platformActorUserId
            : null;
    return humanAdminActor(email, memberId);
  }
  throw new Error("admin_audit_actor_missing");
}

function withApproverEmail(actor: AdminAgentAuditActor, approval: AdminAuditApprovalRef): AdminAgentAuditActor {
  const email = extractEmail(approval.resolvedBy);
  return email ? { ...actor, actorEmail: email } : actor;
}

export async function adminActorFromOrgAgent(orgId: string): Promise<AdminAuditActor> {
  const { getOrgAdminAgent } = await import("@/lib/data/admin-agents");
  const agent = await getOrgAdminAgent(orgId);
  if (!agent) throw new Error("admin_audit_actor_missing");
  return adminAgentAuditActor(agent.id, agent.credentialGeneration);
}

export async function resolveAdminAuditActor(input: {
  cred?: { adminAgentId: string; generation: number } | null;
  human?: { email: string; memberId?: string | null } | null;
  approval?: AdminAuditApprovalRef | null;
  orgId?: string | null;
  fallbackHuman?: { email: string; memberId?: string | null } | null;
  /** Used only when the who-required flag applies: system path, no human session. */
  systemLabel?: string | null;
}): Promise<AdminAuditActor> {
  if (input.cred?.adminAgentId) {
    return adminAgentAuditActor(input.cred.adminAgentId, input.cred.generation);
  }
  if (input.human?.email) {
    return humanAdminActor(input.human.email, input.human.memberId);
  }
  if (input.approval) {
    try {
      return await attachApproverEmail(adminActorFromApproval(input.approval), input.approval, input.orgId);
    } catch {
      /* fall through */
    }
  }
  if (input.orgId && isAdminAuditWhoRequiredEnabledForOrg(input.orgId) && input.systemLabel) {
    return systemAdminActor(input.systemLabel);
  }
  if (input.orgId) {
    try {
      return await adminActorFromOrgAgent(input.orgId);
    } catch {
      /* fall through */
    }
  }
  if (input.fallbackHuman?.email) {
    return humanAdminActor(input.fallbackHuman.email, input.fallbackHuman.memberId);
  }
  throw new Error("admin_audit_actor_missing");
}

async function attachApproverEmail(
  actor: AdminAuditActor,
  approval: AdminAuditApprovalRef,
  orgId?: string | null
): Promise<AdminAuditActor> {
  if (actor.actorKind === "human" || actor.actorKind === "system") return actor;
  if (extractEmail(actor.actorEmail)) return actor;
  const fromResolved = extractEmail(approval.resolvedBy);
  if (fromResolved) return { ...actor, actorEmail: fromResolved };
  const memberId = (approval.approverMemberId || "").trim();
  if (!memberId || !orgId) return actor;
  const { getMemberById } = await import("@/lib/data/members");
  const member = await getMemberById(memberId, orgId).catch(() => null);
  if (!member || member.orgId !== orgId) return actor;
  const email = extractEmail(member.email);
  return email ? { ...actor, actorEmail: email } : actor;
}

function asEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

const MAX_SECRET_SCAN_DEPTH = 8;
const MAX_SECRET_SCAN_NODES = 256;
const MAX_SECRET_SCAN_STRING = 4096;

function isAllowedPrefixField(key: string, value: unknown): boolean {
  if (key === "secretHashPrefix") {
    return typeof value === "string" && value.length <= 12;
  }
  return key === "prefix" && (value === "gb_adm_" || value === "gb_emp_" || value === "sp_at_");
}

function rejectSecretsInValue(
  value: unknown,
  key = "",
  depth = 0,
  counter = { n: 0 }
): void {
  counter.n += 1;
  if (depth > MAX_SECRET_SCAN_DEPTH || counter.n > MAX_SECRET_SCAN_NODES) {
    throw new Error("admin_audit_metadata_too_large");
  }
  if (isAllowedPrefixField(key, value)) return;
  if (SECRET_KEY.test(key)) {
    if (HASH_KEY.test(key)) throw new Error("admin_audit_full_hash_forbidden");
    if (/prefix/i.test(key)) throw new Error("admin_audit_full_prefix_forbidden");
    throw new Error("admin_audit_secret_forbidden");
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretsInValue(item, key, depth + 1, counter);
    return;
  }
  if (value && typeof value === "object") {
    rejectSecrets(value as Record<string, unknown>, depth + 1, counter);
    return;
  }
  if (typeof value !== "string") return;
  if (value.length > MAX_SECRET_SCAN_STRING) {
    throw new Error("admin_audit_metadata_too_large");
  }
  if (/prefix/i.test(key) && /^(gb_adm_|gb_emp_|sp_at_)/.test(value) && value.length > 7) {
    throw new Error("admin_audit_full_prefix_forbidden");
  }
  if (HASH_KEY.test(key) && value.length > 12) {
    throw new Error("admin_audit_full_hash_forbidden");
  }
  if (SECRET_VALUE.test(value) || POLL_URL_RE.test(value)) {
    throw new Error("admin_audit_secret_forbidden");
  }
  if (LONG_HEX.test(value)) {
    throw new Error("admin_audit_full_hash_forbidden");
  }
}

function rejectSecrets(
  metadata: Record<string, unknown>,
  depth = 0,
  counter = { n: 0 }
): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "secretHashPrefix" && typeof value === "string" && value.length > 12) {
      throw new Error("admin_audit_hash_too_long");
    }
    rejectSecretsInValue(value, key, depth, counter);
  }
}

export function assertAdminAuditIdentity(event: {
  action: string;
  actorEmail?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  orgId?: string | null;
}): void {
  const action = (event.action || "").trim();
  if (!action.startsWith("admin.")) {
    throw new Error("admin_audit_action_required");
  }
  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const actorKind = metadata.actorKind;
  const whoRequired = isAdminAuditWhoRequiredEnabledForOrg(event.orgId);
  if (whoRequired) {
    if (actorKind === "human") {
      const email = asEmail(event.actorEmail) ?? asEmail(metadata.actorEmail);
      if (!email) throw new Error("admin_audit_actor_email_required");
    } else if (actorKind === "system") {
      const label = typeof metadata.actorLabel === "string" ? metadata.actorLabel.trim() : "";
      if (!label) throw new Error("admin_audit_actorLabel_required");
      if (label.includes("@") || isEmailLike(label)) {
        throw new Error("admin_audit_actorLabel_email_forbidden");
      }
      const systemEmail = asEmail(event.actorEmail) ?? asEmail(metadata.actorEmail);
      if (systemEmail) throw new Error("admin_audit_system_email_forbidden");
    } else {
      throw new Error("admin_audit_actorKind_required");
    }
  } else {
    if (actorKind !== "human" && actorKind !== "admin_agent") {
      throw new Error("admin_audit_actorKind_required");
    }
    if (actorKind === "human") {
      const email = asEmail(event.actorEmail) ?? asEmail(metadata.actorEmail);
      if (!email) throw new Error("admin_audit_actor_email_required");
    } else {
      const adminAgentId = typeof metadata.adminAgentId === "string" ? metadata.adminAgentId.trim() : "";
      if (!adminAgentId) throw new Error("admin_audit_adminAgentId_required");
      if (!Number.isFinite(Number(metadata.generation))) {
        throw new Error("admin_audit_generation_required");
      }
    }
  }
  rejectSecrets(metadata);
  if (typeof event.summary === "string") {
    rejectSecretsInValue(event.summary, "summary");
  }
}

export function sanitizeAdminRevokeReason(
  value: unknown
): { ok: true; reason: string } | { ok: false; error: "invalid_reason" } {
  if (value == null || value === "") return { ok: true, reason: "" };
  if (typeof value !== "string") return { ok: false, error: "invalid_reason" };
  const reason = value.trim().slice(0, 300);
  if (!reason) return { ok: true, reason: "" };
  if (CONTROL_CHARS.test(reason)) return { ok: false, error: "invalid_reason" };
  try {
    rejectSecretsInValue(reason, "reason");
  } catch {
    return { ok: false, error: "invalid_reason" };
  }
  return { ok: true, reason };
}

export async function ensureAdminRevokeAudit(input: {
  orgId: string;
  credentialId: string | null;
  generation: number;
  actor: HumanAdminAuditActor;
  reason?: string;
}): Promise<void> {
  const { listAuditEventsByActionSince } = await import("@/lib/data/audit");
  const events = await listAuditEventsByActionSince(
    input.orgId,
    "admin.revoke",
    "1970-01-01T00:00:00.000Z",
    500
  ).catch(() => []);
  const exists = events.some((event) => Number(event.metadata?.generation) === input.generation);
  if (exists) return;
  await appendAdminAuditEvent({
    orgId: input.orgId,
    employeeId: null,
    credentialId: input.credentialId,
    action: "admin.revoke",
    purpose: "admin.revoke",
    summary: "管理用の認証を失効（人のタップ）",
    actor: input.actor,
    metadata: {
      generation: input.generation,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}

function normalizeAdminWhoActor(actor: AdminAuditActor, orgId: string): AdminAuditActor {
  if (!isAdminAuditWhoRequiredEnabledForOrg(orgId)) return actor;
  if (actor.actorKind !== "admin_agent") return actor;
  const email = extractEmail(actor.actorEmail);
  if (email) return humanAdminActor(email);
  return systemAdminActor(ADMIN_AUDIT_SYSTEM_LABEL.adminMcp, {
    adminAgentId: actor.adminAgentId,
    generation: actor.generation,
  });
}

function actorEmailForWrite(actor: AdminAuditActor, eventEmail: string | null | undefined, whoRequired: boolean): string | null {
  if (actor.actorKind === "human") return actor.actorEmail;
  if (actor.actorKind === "system") return whoRequired ? null : eventEmail ?? null;
  return eventEmail ?? actor.actorEmail ?? null;
}

export function adminAuditReason(code: string, fallbackJa?: string): AdminAuditReason {
  const trimmed = String(code ?? "").trim();
  const mapped = AUDIT_REASON_JA[trimmed];
  return { code: trimmed, labelJa: mapped?.ja ?? fallbackJa ?? `理由コード: ${trimmed || "不明"}` };
}

export function adminSixFieldAction<T extends string, U extends AuditAction>(
  orgId: string,
  legacy: T,
  admin: U
): T | U {
  return isAdminAuditSixFieldWriteEnabledForOrg(orgId) ? admin : legacy;
}

export function summarizeInternalAudienceRule(rule: unknown): {
  ruleSummary: { domainCount: number; teamCount: number; autoSlackTeamInternal: boolean };
} {
  const obj = rule && typeof rule === "object" ? (rule as Record<string, unknown>) : {};
  const domains = Array.isArray(obj.emailDomains) ? obj.emailDomains.map(String) : [];
  const teams = Array.isArray(obj.slackTeamIds) ? obj.slackTeamIds.map(String) : [];
  return {
    ruleSummary: {
      domainCount: domains.length,
      teamCount: teams.length,
      autoSlackTeamInternal: obj.autoSlackTeamInternal === true,
    },
  };
}

function isTarget(value: unknown): value is AdminAuditTarget {
  if (!value || typeof value !== "object") return false;
  const t = value as AdminAuditTarget;
  return typeof t.type === "string" && t.type.trim() !== "" && typeof t.id === "string" && t.id.trim() !== "";
}

function isReason(value: unknown): value is AdminAuditReason {
  if (!value || typeof value !== "object") return false;
  const r = value as AdminAuditReason;
  return typeof r.code === "string" && r.code.trim() !== "" && typeof r.labelJa === "string" && r.labelJa.trim() !== "";
}

function isResult(value: unknown): value is AdminAuditResult {
  return typeof value === "string" && ADMIN_AUDIT_RESULTS.has(value as AdminAuditResult);
}

function shortCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return REASON_CODE_RE.test(t) ? t : null;
}

function inferReasonCode(event: {
  purpose?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}): string {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const fromMeta = shortCode(meta.code) ?? shortCode(meta.reasonCode) ?? shortCode(meta.reason);
  if (fromMeta) return fromMeta;
  const blob = `${event.purpose ?? ""} ${event.summary ?? ""}`;
  if (/承認待ち|needs_approval/i.test(blob)) return "needs_approval";
  if (/拒否|denied|not_authorized|authority/i.test(blob)) return "approver_not_authorized";
  if (/競合|stale|mismatch|conflict/i.test(blob)) return "stale_base";
  if (/無効|disabled|feature_disabled/i.test(blob)) return "feature_disabled";
  return "approved";
}

function inferResult(code: string, event: { purpose?: string | null; summary?: string | null; result?: AdminAuditResult }): AdminAuditResult {
  if (event.result && isResult(event.result)) return event.result;
  const mapped = AUDIT_REASON_JA[code]?.kind;
  if (mapped === "denied") return "denied";
  if (mapped === "pending") return "pending";
  if (mapped === "failure") return "error";
  if (mapped === "success") return "success";
  const blob = `${event.purpose ?? ""} ${event.summary ?? ""}`;
  if (/承認待ち|needs_approval/i.test(blob)) return "pending";
  if (/拒否|denied/i.test(blob)) return "denied";
  if (/失敗|error|conflict|mismatch/i.test(blob)) return "error";
  return "success";
}

function deriveTarget(event: {
  orgId: string;
  employeeId?: string | null;
  target?: AdminAuditTarget;
  metadata?: Record<string, unknown> | null;
}): AdminAuditTarget {
  if (isTarget(event.target)) return { type: event.target.type.trim(), id: event.target.id.trim() };
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  if (isTarget(meta.target)) return { type: meta.target.type.trim(), id: meta.target.id.trim() };
  const employeeId = typeof event.employeeId === "string" ? event.employeeId.trim() : "";
  if (employeeId) return { type: "employee", id: employeeId };
  const approvalId = typeof meta.approvalId === "string" ? meta.approvalId.trim() : "";
  if (approvalId) return { type: "approval", id: approvalId };
  return { type: "org", id: event.orgId };
}

function deriveReason(event: {
  reason?: AdminAuditReason;
  purpose?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}): AdminAuditReason {
  if (isReason(event.reason)) {
    return { code: event.reason.code.trim(), labelJa: event.reason.labelJa.trim().slice(0, MAX_REASON_LABEL) };
  }
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  if (isReason(meta.reason)) {
    return { code: meta.reason.code.trim(), labelJa: meta.reason.labelJa.trim().slice(0, MAX_REASON_LABEL) };
  }
  return adminAuditReason(inferReasonCode(event));
}

function redactRuleMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!("rule" in metadata)) return metadata;
  const { rule, ...rest } = metadata;
  const summary = summarizeInternalAudienceRule(rule);
  return { ...rest, ...summary };
}

function dropUnstructuredReason(metadata: Record<string, unknown>): Record<string, unknown> {
  if (typeof metadata.reason !== "string") return metadata;
  const rest = { ...metadata };
  delete rest.reason;
  return rest;
}

function assertAdminAuditSixField(event: {
  orgId: string;
  summary?: string | null;
  metadata: Record<string, unknown>;
}): void {
  if (!isAdminAuditSixFieldWriteEnabledForOrg(event.orgId)) return;
  const target = event.metadata.target;
  if (!isTarget(target)) throw new Error("admin_audit_target_required");
  if (target.type.length > MAX_TARGET_TYPE || target.id.length > MAX_TARGET_ID) {
    throw new Error("admin_audit_target_too_long");
  }
  rejectSecretsInValue(target.type, "target.type");
  rejectSecretsInValue(target.id, "target.id");
  if (target.type.includes("@") || target.id.includes("@") || isEmailLike(target.id)) {
    throw new Error("admin_audit_target_pii");
  }
  const reason = event.metadata.reason;
  if (!isReason(reason)) throw new Error("admin_audit_reason_required");
  if (reason.code.length > 64 || reason.labelJa.length > MAX_REASON_LABEL) {
    throw new Error("admin_audit_reason_too_long");
  }
  if (reason.labelJa.includes("@") || isEmailLike(reason.labelJa) || reason.code.includes("@")) {
    throw new Error("admin_audit_reason_pii");
  }
  rejectSecretsInValue(reason.code, "reason");
  rejectSecretsInValue(reason.labelJa, "reason");
  if (!isResult(event.metadata.result)) throw new Error("admin_audit_result_required");
  if ("rule" in event.metadata) throw new Error("admin_audit_rule_text_forbidden");
}

export async function appendAdminAuditEvent(
  event: Omit<AuditEvent, "id" | "createdAt" | "actorEmail" | "metadata"> & {
    actor: AdminAuditActor;
    actorEmail?: string | null;
    metadata?: Record<string, unknown>;
    action: AuditAction;
    target?: AdminAuditTarget;
    reason?: AdminAuditReason;
    result?: AdminAuditResult;
  }
): Promise<void> {
  const whoRequired = isAdminAuditWhoRequiredEnabledForOrg(event.orgId);
  const sixField = isAdminAuditSixFieldWriteEnabledForOrg(event.orgId);
  const actor = normalizeAdminWhoActor(event.actor, event.orgId);
  const actorMeta = adminActorMetadata(actor);
  let metadata: Record<string, unknown> = { ...(event.metadata ?? {}), ...actorMeta };
  if (sixField) {
    metadata = redactRuleMetadata(metadata);
    const reason = deriveReason(event);
    const result = inferResult(reason.code, event);
    metadata = dropUnstructuredReason(metadata);
    metadata.target = deriveTarget(event);
    metadata.reason = reason;
    metadata.result = result;
  }
  const actorEmail = actorEmailForWrite(actor, event.actorEmail, whoRequired);
  assertAdminAuditIdentity({
    action: event.action,
    actorEmail,
    summary: event.summary,
    metadata,
    orgId: event.orgId,
  });
  if (sixField) {
    assertAdminAuditSixField({ orgId: event.orgId, summary: event.summary, metadata });
  }
  await appendAuditEvent({
    orgId: event.orgId,
    employeeId: event.employeeId,
    credentialId: event.credentialId,
    actorEmail,
    action: event.action,
    purpose: event.purpose,
    summary: event.summary,
    metadata,
  });
}

export async function appendAdminClassAuditEvent(event: {
  orgId: string;
  employeeId?: string | null;
  credentialId?: string | null;
  actor?: AdminAuditActor;
  actorEmail?: string | null;
  approval?: AdminAuditApprovalRef | null;
  systemLabel?: string;
  legacyAction: AuditAction;
  adminAction: AuditAction;
  purpose: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  target?: AdminAuditTarget;
  reason?: AdminAuditReason;
  result?: AdminAuditResult;
}): Promise<void> {
  if (!isAdminAuditSixFieldWriteEnabledForOrg(event.orgId)) {
    await appendAuditEvent({
      orgId: event.orgId,
      employeeId: event.employeeId ?? null,
      credentialId: event.credentialId ?? null,
      actorEmail: event.actorEmail,
      action: event.legacyAction,
      purpose: event.purpose,
      summary: event.summary,
      metadata: event.metadata ?? {},
    });
    return;
  }
  const email = extractEmail(event.actorEmail);
  const actor =
    event.actor ??
    (await resolveAdminAuditActor({
      orgId: event.orgId,
      approval: event.approval,
      human: email ? { email } : undefined,
      systemLabel: event.systemLabel ?? ADMIN_AUDIT_SYSTEM_LABEL.adminMcp,
    }));
  await appendAdminAuditEvent({
    orgId: event.orgId,
    employeeId: event.employeeId ?? null,
    credentialId: event.credentialId ?? null,
    actor,
    actorEmail: event.actorEmail,
    action: event.adminAction,
    purpose: event.purpose,
    summary: event.summary,
    metadata: event.metadata,
    target: event.target,
    reason: event.reason,
    result: event.result,
  });
}
