/**
 * The single decision function for every human-member capability / role change
 * (team API edit + invite, org bootstrap, UI checkbox state).
 *
 * Pure: no I/O. Callers must pass
 *   - actor: loaded from the session / DB (never from request fields),
 *   - before: the target's CURRENT row in the same org (null = new invite),
 *   - after: the requested values,
 *   - ownerCount: active owners in the org, read from the DB.
 *
 * Rules (all cumulative):
 *   1. approve_actions / manage_billing / manage_spend_limits: grant or revoke → owner only.
 *      owner role: grant or revoke → owner only. An owner's role/capabilities/email → owner only.
 *   2. Raising one's own capabilities or role is refused for everyone (owner included).
 *      Lowering is allowed. "Self" = same member id OR same Auth user id OR any
 *      case-/whitespace-insensitive match against the actor's profile/Auth emails.
 *   3. The last active owner cannot lose the owner role.
 *   4. Unknown capability / role values are refused.
 */
import type { HumanCapability, OrgMemberRole } from "@/lib/types";

export const KNOWN_CAPABILITIES: readonly HumanCapability[] = [
  "view_dashboard",
  "view_employees",
  "view_audit",
  "approve_actions",
  "manage_spend_limits",
  "hire_issue_credentials",
  "manage_team",
  "manage_billing",
];

/** Capabilities only an owner may grant or revoke. */
export const PRIVILEGED_CAPABILITIES: readonly HumanCapability[] = [
  "approve_actions",
  "manage_billing",
  "manage_spend_limits",
];

export const KNOWN_ROLES: readonly OrgMemberRole[] = ["owner", "admin", "member"];

const ROLE_RANK: Record<OrgMemberRole, number> = { member: 0, admin: 1, owner: 2 };

export type MemberChangeDenyCode =
  | "unknown_capability"
  | "unknown_role"
  | "cross_org_target"
  | "actor_not_active_member"
  | "manage_team_required"
  | "owner_target_requires_owner"
  | "self_escalation_forbidden"
  | "owner_required_for_owner_role"
  | "owner_required_for_privileged_capability"
  | "last_owner_required"
  | "bootstrap_not_allowed"
  // Raised by the orchestrator (lib/team/apply-member-change.ts), not by evaluateMemberChange:
  | "target_not_found"
  | "email_conflict"
  | "concurrent_modification";

export const MEMBER_CHANGE_DENY_MESSAGES_JA: Record<MemberChangeDenyCode, string> = {
  unknown_capability: "不明な権限が含まれています。画面を再読み込みしてやり直してください。",
  unknown_role: "不明な席種別です（owner / admin / member のいずれかを選んでください）。",
  cross_org_target: "別の組織のメンバーは変更できません。",
  actor_not_active_member: "操作した人を、この組織の有効なメンバーとして確認できません。再ログインしてください。",
  manage_team_required: "メンバーの追加・編集には「メンバー追加・編集」の権限が必要です。",
  owner_target_requires_owner: "オーナーの権限・席種別・メールアドレスは、オーナーだけが変更できます。",
  self_escalation_forbidden: "自分自身の権限や席種別を上げることはできません（オーナーも同じです）。別のオーナーに依頼してください。",
  owner_required_for_owner_role: "オーナー席の付与・解除は、オーナーだけが実行できます。",
  owner_required_for_privileged_capability:
    "「承認キュー」「請求・契約」「予算上限の管理」の権限の付与・解除は、オーナーだけが実行できます。",
  last_owner_required: "最後のオーナーは外せません。先に別のメンバーをオーナーにしてください。",
  bootstrap_not_allowed: "初期オーナーの作成は、オーナーがまだいない新しい組織でだけ実行できます。",
  target_not_found: "対象のメンバーが見つかりません。画面を再読み込みしてください。",
  email_conflict: "このメールアドレスは別のメンバーが使っています。",
  concurrent_modification: "ほかの操作で内容が変わりました。画面を再読み込みしてやり直してください。",
};

export type MemberChangeActor =
  | {
      kind: "member";
      id: string;
      userId?: string | null;
      orgId: string;
      role: string;
      capabilities: readonly string[];
      status: string;
      /** Profile email + Auth email(s). Compared case-insensitively. */
      emails: readonly (string | null | undefined)[];
    }
  | { kind: "system_bootstrap"; orgId: string };

/** Org provisioning (signup / platform orgs.create): may only create the first owner. */
export function SYSTEM_BOOTSTRAP_ACTOR(orgId: string): MemberChangeActor {
  return { kind: "system_bootstrap", orgId };
}

export type MemberSnapshot = {
  id: string;
  userId?: string | null;
  orgId: string;
  email: string;
  role: string;
  capabilities: readonly string[];
  status: string;
};

export type MemberChangeAfter = {
  orgId: string;
  email: string;
  role: unknown;
  capabilities: readonly unknown[];
};

export type MemberChangeInput = {
  actor: MemberChangeActor;
  before: MemberSnapshot | null;
  after: MemberChangeAfter;
  /** Active owners in the org (DB). */
  ownerCount: number;
};

export type MemberChangeAllowed = {
  ok: true;
  isSelf: boolean;
  isInvite: boolean;
  roleBefore: OrgMemberRole | null;
  roleAfter: OrgMemberRole;
  capabilitiesBefore: string[];
  capabilitiesAfter: HumanCapability[];
  added: HumanCapability[];
  removed: string[];
};

export type MemberChangeDenied = {
  ok: false;
  code: MemberChangeDenyCode;
  messageJa: string;
  /** e.g. the unknown / privileged capabilities that triggered the denial. */
  capabilities?: string[];
};

export type MemberChangeDecision = MemberChangeAllowed | MemberChangeDenied;

export function denyMemberChange(code: MemberChangeDenyCode, capabilities?: string[]): MemberChangeDenied {
  return { ok: false, code, messageJa: MEMBER_CHANGE_DENY_MESSAGES_JA[code], ...(capabilities ? { capabilities } : {}) };
}

export function normalizeIdentityEmail(email: unknown): string {
  return typeof email === "string" ? email.normalize("NFKC").trim().toLowerCase() : "";
}

function isKnownCapability(value: unknown): value is HumanCapability {
  return typeof value === "string" && (KNOWN_CAPABILITIES as readonly string[]).includes(value);
}

function isKnownRole(value: unknown): value is OrgMemberRole {
  return typeof value === "string" && (KNOWN_ROLES as readonly string[]).includes(value);
}

function rank(role: string | null | undefined): number {
  return isKnownRole(role) ? ROLE_RANK[role] : 0;
}

function isSelfChange(
  actor: Extract<MemberChangeActor, { kind: "member" }>,
  before: MemberSnapshot | null,
  afterEmail: string
): boolean {
  if (before && before.id === actor.id) return true;
  if (before?.userId && actor.userId && before.userId === actor.userId) return true;
  const mine = new Set(actor.emails.map(normalizeIdentityEmail).filter(Boolean));
  if (before && mine.has(normalizeIdentityEmail(before.email))) return true;
  if (mine.has(normalizeIdentityEmail(afterEmail))) return true;
  return false;
}

export function evaluateMemberChange(input: MemberChangeInput): MemberChangeDecision {
  const { actor, before, after } = input;
  const ownerCount = Number.isFinite(input.ownerCount) ? input.ownerCount : 0;

  // 4. Input values.
  if (!isKnownRole(after.role)) return denyMemberChange("unknown_role");
  const requested = Array.isArray(after.capabilities) ? after.capabilities : [];
  const unknown = requested.filter((c) => !isKnownCapability(c)).map((c) => String(c));
  if (unknown.length) return denyMemberChange("unknown_capability", unknown);
  const capsAfter = [...new Set(requested as HumanCapability[])];
  const roleAfter = after.role;

  // Tenant isolation: target and requested row stay in the actor's org.
  if (after.orgId !== actor.orgId || (before && before.orgId !== actor.orgId)) {
    return denyMemberChange("cross_org_target");
  }

  const capsBefore = [...new Set(before?.capabilities ?? [])];
  const added = capsAfter.filter((c) => !capsBefore.includes(c));
  const removed = capsBefore.filter((c) => !(capsAfter as string[]).includes(c));
  const roleBefore = before ? (isKnownRole(before.role) ? before.role : null) : null;
  const wasOwner = before?.role === "owner";
  const ownerRoleChanged = wasOwner !== (roleAfter === "owner");
  const roleChanged = (before?.role ?? null) !== roleAfter;
  const emailChanged = before ? normalizeIdentityEmail(before.email) !== normalizeIdentityEmail(after.email) : false;

  const allowed = (isSelf: boolean): MemberChangeAllowed => ({
    ok: true,
    isSelf,
    isInvite: !before,
    roleBefore,
    roleAfter,
    capabilitiesBefore: capsBefore,
    capabilitiesAfter: capsAfter,
    added,
    removed,
  });

  if (actor.kind === "system_bootstrap") {
    if (before || ownerCount > 0 || roleAfter !== "owner") return denyMemberChange("bootstrap_not_allowed");
    return allowed(false);
  }

  if (actor.status !== "active") return denyMemberChange("actor_not_active_member");
  if (!actor.capabilities.includes("manage_team")) return denyMemberChange("manage_team_required");

  const actorIsOwner = actor.role === "owner";
  const isSelf = isSelfChange(actor, before, after.email);

  // 1c. Non-owners never change an owner's privileges or identity email.
  if (wasOwner && !actorIsOwner && (added.length || removed.length || roleChanged || emailChanged)) {
    return denyMemberChange("owner_target_requires_owner");
  }

  // 2. No self escalation (owner included). For a self "invite" the baseline is no access.
  if (isSelf && (added.length > 0 || rank(roleAfter) > (before ? rank(before.role) : -1))) {
    return denyMemberChange("self_escalation_forbidden");
  }

  // 1a/1b. Owner-only privileges.
  if (ownerRoleChanged && !actorIsOwner) return denyMemberChange("owner_required_for_owner_role");
  const privilegedTouched = [...added, ...removed].filter((c) =>
    (PRIVILEGED_CAPABILITIES as readonly string[]).includes(c)
  );
  if (privilegedTouched.length && !actorIsOwner) {
    return denyMemberChange("owner_required_for_privileged_capability", privilegedTouched);
  }

  // 3. Keep at least one active owner.
  if (wasOwner && before?.status === "active" && roleAfter !== "owner" && ownerCount <= 1) {
    return denyMemberChange("last_owner_required");
  }

  return allowed(isSelf);
}

export type MemberChangeEditability = {
  capabilities: Record<HumanCapability, boolean>;
  roles: Record<OrgMemberRole, boolean>;
};

/**
 * Checkbox / select state derived from evaluateMemberChange: a box is enabled
 * iff toggling ONLY that box from the current row would be allowed.
 * UI hint only — the server re-evaluates every request.
 */
export function memberChangeEditability(input: {
  actor: MemberChangeActor;
  before: MemberSnapshot | null;
  ownerCount: number;
}): MemberChangeEditability {
  const { actor, before, ownerCount } = input;
  const baseCaps = (before?.capabilities ?? []).filter(isKnownCapability);
  const baseRole: OrgMemberRole = before && isKnownRole(before.role) ? before.role : "member";
  const orgId = before?.orgId ?? actor.orgId;
  const email = before?.email ?? "";
  const capabilities = {} as Record<HumanCapability, boolean>;
  for (const cap of KNOWN_CAPABILITIES) {
    const next = before
      ? baseCaps.includes(cap)
        ? baseCaps.filter((c) => c !== cap)
        : [...baseCaps, cap]
      : [cap];
    capabilities[cap] = evaluateMemberChange({
      actor,
      before: before ? { ...before, capabilities: baseCaps } : null,
      after: { orgId, email, role: baseRole, capabilities: next },
      ownerCount,
    }).ok;
  }
  const roles = {} as Record<OrgMemberRole, boolean>;
  for (const role of KNOWN_ROLES) {
    roles[role] = evaluateMemberChange({
      actor,
      before: before ? { ...before, capabilities: baseCaps } : null,
      after: { orgId, email, role, capabilities: before ? baseCaps : ["view_dashboard"] },
      ownerCount,
    }).ok;
  }
  return { capabilities, roles };
}
