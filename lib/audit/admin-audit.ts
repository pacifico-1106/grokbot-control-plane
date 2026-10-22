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
import { appendAuditEvent } from "@/lib/data/audit";
import { isAdminAuditWhoRequiredEnabledForOrg } from "@/lib/feature-flags";
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
  return systemAdminActor(ADMIN_AUDIT_SYSTEM_LABEL.adminMcp, {
    adminAgentId: actor.adminAgentId,
    generation: actor.generation,
  });
}

function actorEmailForWrite(
  original: AdminAuditActor,
  eventEmail: string | null | undefined,
  whoRequired: boolean
): string | null {
  if (original.actorKind === "human") return original.actorEmail;
  const fromActor = original.actorKind === "admin_agent" ? original.actorEmail ?? null : null;
  if (whoRequired) return extractEmail(fromActor);
  return eventEmail ?? fromActor ?? null;
}

export async function appendAdminAuditEvent(
  event: Omit<AuditEvent, "id" | "createdAt" | "actorEmail" | "metadata"> & {
    actor: AdminAuditActor;
    actorEmail?: string | null;
    metadata?: Record<string, unknown>;
    action: AuditAction;
  }
): Promise<void> {
  const whoRequired = isAdminAuditWhoRequiredEnabledForOrg(event.orgId);
  const actor = normalizeAdminWhoActor(event.actor, event.orgId);
  const actorMeta = adminActorMetadata(actor);
  const metadata = { ...(event.metadata ?? {}), ...actorMeta };
  const actorEmail = actorEmailForWrite(event.actor, event.actorEmail, whoRequired);
  assertAdminAuditIdentity({
    action: event.action,
    actorEmail,
    summary: event.summary,
    metadata,
    orgId: event.orgId,
  });
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
