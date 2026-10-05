/**
 * Server-side orchestrator for human-member edits / invites:
 *   fresh DB read (same org) → evaluateMemberChange → conditional write → audit.
 * Every allow AND deny is recorded via appendAuditEvent with before/after.
 */
import { getSessionContext } from "@/lib/auth/session";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  MemberConcurrentModificationError,
  MemberLastOwnerError,
  listMembers,
  writeMemberRow,
} from "@/lib/data/members";
import { isDemoMode } from "@/lib/mode";
import { resolveDemoActor } from "@/lib/team/demo-actor";
import {
  ACTIVE_MEMBER_REQUIRED_CODE,
  ACTIVE_MEMBER_REQUIRED_ERROR,
  ACTIVE_MEMBER_REQUIRED_MESSAGE_JA,
  ACTIVE_MEMBER_REQUIRED_STATUS,
  activeSessionMember,
} from "@/lib/auth/active-member";
import {
  denyMemberChange,
  evaluateMemberChange,
  memberChangeEditability,
  normalizeIdentityEmail,
  type MemberChangeActor,
  type MemberChangeDenyCode,
  type MemberChangeEditability,
  type MemberSnapshot,
} from "@/lib/team/member-change-guard";
import { JOB_ROLE_CAPABILITY_PACKS } from "@/lib/team/rbac";
import type { HumanJobRole, OrgMember } from "@/lib/types";

export type MemberChangeSource = "team_api" | "admin_mcp_promote_owner";

export type MemberChangeRequest = {
  orgId: string;
  /** Session member (production) / demo store member. Re-read from the DB below. */
  actor: OrgMember;
  /** Auth email of the session user (may differ from the profile email). */
  actorAuthEmail?: string | null;
  targetId?: string | null;
  email: string;
  displayName: string;
  /** Requested role; omitted → keep current (invite → "member"). */
  role?: unknown;
  jobRole?: HumanJobRole;
  jobLabel?: string | null;
  capabilities: unknown;
  source: MemberChangeSource;
};

export type MemberChangeResult =
  | { ok: true; member: OrgMember; before: OrgMember | null }
  | { ok: false; code: MemberChangeDenyCode; messageJa: string; httpStatus: number; capabilities?: string[] };

const HTTP_STATUS: Partial<Record<MemberChangeDenyCode, number>> = {
  unknown_capability: 400,
  unknown_role: 400,
  target_not_found: 404,
  email_conflict: 409,
  concurrent_modification: 409,
};

function snapshot(m: OrgMember): MemberSnapshot {
  return {
    id: m.id,
    userId: m.userId ?? null,
    orgId: m.orgId,
    email: m.email,
    role: m.role,
    capabilities: [...(m.capabilities ?? [])],
    status: m.status,
  };
}

export function guardActorFromMember(m: OrgMember, authEmail?: string | null): MemberChangeActor {
  return {
    kind: "member",
    id: m.id,
    userId: m.userId ?? null,
    orgId: m.orgId,
    role: m.role,
    capabilities: [...(m.capabilities ?? [])],
    status: m.status,
    emails: [m.email, authEmail ?? null],
  };
}

export function countActiveOwners(members: readonly OrgMember[]): number {
  return members.filter((m) => m.role === "owner" && m.status === "active").length;
}

/**
 * Actor for member changes. Production: the session's active org_members row
 * only — x-member-id / ?as= / body actorMemberId are ignored and there is no
 * owner fallback. No active member row for the session org → 401
 * auth_required / active_member_required (same contract as requireCapability).
 * A member who lacks the permission is decided later by evaluateMemberChange
 * (403). DEMO: the in-memory demo actor (demo has no Auth).
 */
export async function resolveMemberChangeActor(
  req?: Request | null,
  bodyActorId?: string | null
): Promise<
  | { ok: true; actor: OrgMember; authEmail: string | null }
  | {
      ok: false;
      error: typeof ACTIVE_MEMBER_REQUIRED_ERROR;
      code: typeof ACTIVE_MEMBER_REQUIRED_CODE;
      messageJa: string;
      httpStatus: typeof ACTIVE_MEMBER_REQUIRED_STATUS;
    }
> {
  if (isDemoMode()) {
    const demoReq = req ?? new Request("http://demo.invalid/app/team");
    return { ok: true, actor: resolveDemoActor(demoReq, bodyActorId), authEmail: null };
  }
  const session = await getSessionContext();
  const member = activeSessionMember(session);
  if (!member) {
    return {
      ok: false,
      error: ACTIVE_MEMBER_REQUIRED_ERROR,
      code: ACTIVE_MEMBER_REQUIRED_CODE,
      messageJa: ACTIVE_MEMBER_REQUIRED_MESSAGE_JA,
      httpStatus: ACTIVE_MEMBER_REQUIRED_STATUS,
    };
  }
  return { ok: true, actor: member, authEmail: session.email ?? null };
}

async function auditDenied(
  req: MemberChangeRequest,
  actor: OrgMember,
  before: OrgMember | null,
  code: MemberChangeDenyCode,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await appendAuditEvent({
    orgId: req.orgId,
    employeeId: null,
    credentialId: null,
    action: "member.change_denied",
    purpose: null,
    summary: `チーム変更を拒否: ${before?.displayName ?? req.displayName}（${code}）`,
    actorEmail: actor.email,
    metadata: {
      code,
      source: req.source,
      actorMemberId: actor.id,
      actorUserId: actor.userId ?? null,
      actorRole: actor.role,
      targetMemberId: before?.id ?? null,
      targetEmail: normalizeIdentityEmail(req.email),
      roleBefore: before?.role ?? null,
      roleRequested: typeof req.role === "string" ? req.role : before?.role ?? "member",
      capabilitiesBefore: [...(before?.capabilities ?? [])],
      capabilitiesRequested: Array.isArray(req.capabilities) ? req.capabilities.map(String) : [],
      ...extra,
    },
  }).catch(() => null);
}

function fail(code: MemberChangeDenyCode, capabilities?: string[]): MemberChangeResult {
  const d = denyMemberChange(code, capabilities);
  return { ok: false, code, messageJa: d.messageJa, httpStatus: HTTP_STATUS[code] ?? 403, ...(capabilities ? { capabilities } : {}) };
}

export async function applyMemberChange(req: MemberChangeRequest): Promise<MemberChangeResult> {
  // Fresh, org-scoped read: actor, target and owner count all come from here.
  const members = await listMembers(req.orgId);
  const inOrg = members.filter((m) => m.orgId === req.orgId);
  const actor = inOrg.find((m) => m.id === req.actor.id) ?? null;
  if (!actor) {
    await auditDenied(req, req.actor, null, "actor_not_active_member");
    return fail("actor_not_active_member");
  }

  const email = normalizeIdentityEmail(req.email);
  const targetId = typeof req.targetId === "string" ? req.targetId.trim() : "";
  const byEmail = inOrg.find((m) => normalizeIdentityEmail(m.email) === email) ?? null;
  let before: OrgMember | null = null;
  if (targetId) {
    before = inOrg.find((m) => m.id === targetId) ?? null;
    if (!before) {
      await auditDenied(req, actor, null, "target_not_found", { requestedTargetId: targetId });
      return fail("target_not_found");
    }
    if (byEmail && byEmail.id !== before.id) {
      await auditDenied(req, actor, before, "email_conflict");
      return fail("email_conflict");
    }
  } else {
    // Same email (any case) = the existing row; never a second row / blind upsert.
    before = byEmail;
  }

  const requestedRole = req.role === undefined || req.role === null || req.role === ""
    ? before?.role ?? "member"
    : req.role;
  const requestedCaps = Array.isArray(req.capabilities) ? req.capabilities : [];

  const decision = evaluateMemberChange({
    actor: guardActorFromMember(actor, req.actorAuthEmail),
    before: before ? snapshot(before) : null,
    after: { orgId: req.orgId, email, role: requestedRole, capabilities: requestedCaps },
    ownerCount: countActiveOwners(inOrg),
  });
  if (!decision.ok) {
    await auditDenied(req, actor, before, decision.code, decision.capabilities ? { capabilities: decision.capabilities } : {});
    return fail(decision.code, decision.capabilities);
  }

  const next: OrgMember = {
    id: before?.id ?? (isDemoMode() ? `mem_${crypto.randomUUID().slice(0, 8)}` : crypto.randomUUID()),
    userId: before?.userId ?? null,
    orgId: req.orgId,
    email,
    displayName: req.displayName,
    role: decision.roleAfter,
    jobRole: req.jobRole || "custom",
    jobLabel: req.jobLabel ?? null,
    capabilities: decision.capabilitiesAfter,
    status: before?.status ?? "invited",
  };

  let saved: OrgMember;
  try {
    saved = await writeMemberRow(
      next,
      req.orgId,
      before ? { role: before.role, capabilities: [...(before.capabilities ?? [])] } : "new"
    );
  } catch (e) {
    if (e instanceof MemberConcurrentModificationError) {
      await auditDenied(req, actor, before, "concurrent_modification");
      return fail("concurrent_modification");
    }
    if (e instanceof MemberLastOwnerError) {
      await auditDenied(req, actor, before, "last_owner_required", { enforcedBy: "db_trigger" });
      return fail("last_owner_required");
    }
    throw e;
  }

  await appendAuditEvent({
    orgId: req.orgId,
    employeeId: null,
    credentialId: null,
    action: before ? "member.updated" : "member.invited",
    purpose: null,
    summary: `チーム更新: ${saved.displayName}（${saved.jobRole ?? saved.role}）`,
    actorEmail: actor.email,
    metadata: {
      memberId: saved.id,
      source: req.source,
      actorMemberId: actor.id,
      actorUserId: actor.userId ?? null,
      actorRole: actor.role,
      self: decision.isSelf,
      jobRole: saved.jobRole,
      // `capabilities` kept for existing audit readers (= after).
      capabilities: decision.capabilitiesAfter,
      capabilitiesBefore: decision.capabilitiesBefore,
      capabilitiesAfter: decision.capabilitiesAfter,
      added: decision.added,
      removed: decision.removed,
      roleBefore: decision.roleBefore,
      roleAfter: decision.roleAfter,
    },
  }).catch(() => null);

  return { ok: true, member: saved, before };
}

/** Per-member checkbox state for GET /api/team/members and the team page. */
export function teamEditability(
  viewer: OrgMember | null,
  members: readonly OrgMember[],
  authEmail?: string | null
): { byMemberId: Record<string, MemberChangeEditability>; invite: MemberChangeEditability } {
  const ownerCount = countActiveOwners(members);
  const fresh = viewer ? members.find((m) => m.id === viewer.id) ?? null : null;
  const actor: MemberChangeActor = fresh
    ? guardActorFromMember(fresh, authEmail)
    : { kind: "member", id: "", orgId: "", role: "member", capabilities: [], status: "disabled", emails: [] };
  const byMemberId: Record<string, MemberChangeEditability> = {};
  for (const m of members) {
    byMemberId[m.id] = memberChangeEditability({ actor, before: snapshot(m), ownerCount });
  }
  return { byMemberId, invite: memberChangeEditability({ actor, before: null, ownerCount }) };
}

/** Standard owner capabilities (same pack as the owner job role / org bootstrap). */
export const OWNER_STANDARD_CAPABILITIES: readonly string[] = JOB_ROLE_CAPABILITY_PACKS.owner;

export type OwnerPromotionRequest = {
  orgId: string;
  /** The owner who approved the ticket (verified approver on the approval row). */
  approverMemberId: string;
  targetMemberId: string;
  /** Target role / capabilities captured at filing; the row must still match. */
  expectedRole: string;
  expectedCapabilities: readonly string[];
  approvalId: string;
};

export type OwnerPromotionResult =
  | { ok: true; member: OrgMember; before: OrgMember; approver: OrgMember }
  | { ok: false; code: MemberChangeDenyCode | "approver_not_owner" | "member_not_active" | "already_owner"; messageJa: string };

/**
 * members.promoteOwner fulfil: fresh org-scoped read → the approving owner is
 * the guard actor → evaluateMemberChange (owner-only owner role, privileged
 * capabilities, no self-escalation) → conditional write (role + capabilities
 * must still equal what the ticket showed) → audit. Same single guard as
 * applyMemberChange; nothing else can set role=owner from the admin MCP.
 */
export async function applyOwnerPromotion(req: OwnerPromotionRequest): Promise<OwnerPromotionResult> {
  const inOrg = (await listMembers(req.orgId)).filter((m) => m.orgId === req.orgId);
  const approver = inOrg.find((m) => m.id === req.approverMemberId) ?? null;
  const before = inOrg.find((m) => m.id === req.targetMemberId) ?? null;
  const auditReq: MemberChangeRequest = {
    orgId: req.orgId,
    actor: approver ?? ({ id: req.approverMemberId, orgId: req.orgId, email: "", displayName: "", role: "member", status: "disabled", capabilities: [] } as OrgMember),
    targetId: req.targetMemberId,
    email: before?.email ?? "",
    displayName: before?.displayName ?? "",
    role: "owner",
    capabilities: [...OWNER_STANDARD_CAPABILITIES],
    source: "admin_mcp_promote_owner",
  };
  const deny = async (code: Exclude<OwnerPromotionResult, { ok: true }>["code"], messageJa?: string): Promise<OwnerPromotionResult> => {
    await auditDenied(auditReq, auditReq.actor, before, code as MemberChangeDenyCode, { approvalId: req.approvalId });
    return { ok: false, code, messageJa: messageJa ?? denyMemberChange(code as MemberChangeDenyCode).messageJa };
  };
  if (!approver || approver.status !== "active" || approver.role !== "owner") {
    return deny("approver_not_owner", "承認したオーナーを、この組織の有効なオーナーとして確認できません。");
  }
  if (!before) return deny("target_not_found");
  if (before.status !== "active") return deny("member_not_active", "対象のメンバーが有効ではありません（招待中・停止中）。");
  if (before.role === "owner") return deny("already_owner", "対象のメンバーはすでにオーナーです。");
  if (before.role !== req.expectedRole || !sameCaps(before.capabilities ?? [], req.expectedCapabilities)) {
    return deny("concurrent_modification");
  }
  const decision = evaluateMemberChange({
    actor: guardActorFromMember(approver),
    before: snapshot(before),
    after: { orgId: req.orgId, email: normalizeIdentityEmail(before.email), role: "owner", capabilities: [...OWNER_STANDARD_CAPABILITIES] },
    ownerCount: countActiveOwners(inOrg),
  });
  if (!decision.ok) return deny(decision.code);
  const next: OrgMember = { ...before, role: decision.roleAfter, capabilities: decision.capabilitiesAfter };
  let saved: OrgMember;
  try {
    saved = await writeMemberRow(next, req.orgId, { role: before.role, capabilities: [...(before.capabilities ?? [])] });
  } catch (e) {
    if (e instanceof MemberConcurrentModificationError) return deny("concurrent_modification");
    throw e;
  }
  await appendAuditEvent({
    orgId: req.orgId,
    employeeId: null,
    credentialId: null,
    action: "member.updated",
    purpose: null,
    summary: `オーナーを追加: ${saved.displayName || saved.id}（オーナー承認）`,
    actorEmail: approver.email,
    metadata: {
      memberId: saved.id,
      source: "admin_mcp_promote_owner",
      approvalId: req.approvalId,
      actorMemberId: approver.id,
      actorUserId: approver.userId ?? null,
      actorRole: approver.role,
      self: decision.isSelf,
      jobRole: saved.jobRole ?? null,
      capabilities: decision.capabilitiesAfter,
      capabilitiesBefore: decision.capabilitiesBefore,
      capabilitiesAfter: decision.capabilitiesAfter,
      added: decision.added,
      removed: decision.removed,
      roleBefore: decision.roleBefore,
      roleAfter: decision.roleAfter,
    },
  }).catch(() => null);
  return { ok: true, member: saved, before, approver };
}

function sameCaps(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((c) => y.has(c));
}
