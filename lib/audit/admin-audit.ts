/**
 * Required identity on every admin.* audit write.
 * Human tap → actor_email + actorKind=human.
 * Admin AI key (gb_adm_) → metadata.adminAgentId + generation + actorKind=admin_agent.
 * Never persist secrets, full hashes, or full secret prefixes.
 */
import { parseAdminRequester } from "@/lib/admin-mcp/self-approval";
import { appendAuditEvent } from "@/lib/data/audit";
import type { AuditAction, AuditEvent } from "@/lib/types";

export type AdminAuditActorKind = "human" | "admin_agent";

export type HumanAdminAuditActor = {
  actorKind: "human";
  actorEmail: string;
  actorMemberId?: string | null;
};

export type AdminAgentAuditActor = {
  actorKind: "admin_agent";
  adminAgentId: string;
  generation: number;
};

export type AdminAuditActor = HumanAdminAuditActor | AdminAgentAuditActor;

const SECRET_KEY =
  /^(oneTimeSecret|rawSecret|secret|token|password|bearer|authorization|credential|secretHash|credentialFingerprint)$/i;
const SECRET_VALUE = /\b(gb_adm_|gb_emp_)[a-zA-Z0-9]{8,}/;
const HASH_KEY = /(hash|fingerprint)/i;

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

export function adminActorMetadata(actor: AdminAuditActor): Record<string, unknown> {
  if (actor.actorKind === "human") {
    return {
      actorKind: "human" as const,
      ...(actor.actorMemberId ? { actorMemberId: actor.actorMemberId } : {}),
    };
  }
  return {
    actorKind: "admin_agent" as const,
    adminAgentId: actor.adminAgentId,
    generation: actor.generation,
  };
}

export function adminActorFromApproval(approval: {
  metadata?: Record<string, unknown> | null;
}): AdminAuditActor {
  const meta = approval.metadata || {};
  const requester = parseAdminRequester(meta);
  if (requester?.actorId) {
    const generation = requester.credentialGeneration;
    if (generation === undefined || !Number.isFinite(generation)) {
      throw new Error("admin_audit_generation_required");
    }
    return adminAgentAuditActor(requester.actorId, generation);
  }
  const adminAgentId = typeof meta.adminAgentId === "string" ? meta.adminAgentId.trim() : "";
  if (adminAgentId && Number.isFinite(Number(meta.generation))) {
    return adminAgentAuditActor(adminAgentId, Number(meta.generation));
  }
  const email =
    (typeof meta.actorEmail === "string" && meta.actorEmail.trim()) ||
    (typeof meta.platformActorEmail === "string" && meta.platformActorEmail.trim()) ||
    "";
  if (email) {
    const memberId =
      typeof meta.actorMemberId === "string"
        ? meta.actorMemberId
        : typeof meta.platformActorUserId === "string"
          ? meta.platformActorUserId
          : null;
    return humanAdminActor(email, memberId);
  }
  throw new Error("admin_audit_actor_missing");
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
  approval?: { metadata?: Record<string, unknown> | null } | null;
  orgId?: string | null;
  fallbackHuman?: { email: string; memberId?: string | null } | null;
}): Promise<AdminAuditActor> {
  if (input.cred?.adminAgentId) {
    return adminAgentAuditActor(input.cred.adminAgentId, input.cred.generation);
  }
  if (input.human?.email) {
    return humanAdminActor(input.human.email, input.human.memberId);
  }
  if (input.approval) {
    try {
      return adminActorFromApproval(input.approval);
    } catch {
      /* fall through */
    }
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
  if (input.orgId) {
    return humanAdminActor("system");
  }
  throw new Error("admin_audit_actor_missing");
}

function asEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

function rejectSecrets(metadata: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "secretHashPrefix") {
      if (typeof value === "string" && value.length > 12) {
        throw new Error("admin_audit_hash_too_long");
      }
      continue;
    }
    if (key === "prefix" && value === "gb_adm_") continue;
    if (SECRET_KEY.test(key)) {
      if (HASH_KEY.test(key)) throw new Error("admin_audit_full_hash_forbidden");
      if (/prefix/i.test(key)) throw new Error("admin_audit_full_prefix_forbidden");
      throw new Error("admin_audit_secret_forbidden");
    }
    if (/prefix/i.test(key) && typeof value === "string" && value.startsWith("gb_adm_") && value.length > 7) {
      throw new Error("admin_audit_full_prefix_forbidden");
    }
    if (HASH_KEY.test(key) && typeof value === "string" && value.length > 12) {
      throw new Error("admin_audit_full_hash_forbidden");
    }
    if (typeof value === "string" && SECRET_VALUE.test(value)) {
      throw new Error("admin_audit_secret_forbidden");
    }
  }
}

export function assertAdminAuditIdentity(event: {
  action: string;
  actorEmail?: string | null;
  metadata?: Record<string, unknown> | null;
}): void {
  const action = (event.action || "").trim();
  if (!action.startsWith("admin.")) {
    throw new Error("admin_audit_action_required");
  }
  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const actorKind = metadata.actorKind;
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
  rejectSecrets(metadata);
}

export async function appendAdminAuditEvent(
  event: Omit<AuditEvent, "id" | "createdAt" | "actorEmail" | "metadata"> & {
    actor: AdminAuditActor;
    actorEmail?: string | null;
    metadata?: Record<string, unknown>;
    action: AuditAction;
  }
): Promise<void> {
  const actorMeta = adminActorMetadata(event.actor);
  const metadata = { ...(event.metadata ?? {}), ...actorMeta };
  const actorEmail =
    event.actor.actorKind === "human" ? event.actor.actorEmail : (event.actorEmail ?? null);
  assertAdminAuditIdentity({ action: event.action, actorEmail, metadata });
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
