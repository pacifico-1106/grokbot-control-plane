/**
 * accounts.suspend / accounts.unsuspend / accounts.delete planner + executor.
 *
 * Safety rails (all enforced at plan time AND re-checked at fulfill time):
 * - platform ops org and SPAM_PROTECTED_ORG_IDS are never targets
 * - orgs with Stripe customer/subscription, AI employees or >3 members are refused
 * - users who belong to any other (non-target) org are refused (suspend/delete)
 * - super-admin / approver user ids are refused
 * - delete requires: latest ledger action = suspend, at least 7 days old,
 *   every user still banned and every membership disabled
 * - all-or-nothing: any blocker → nothing executes
 * - previewHash binds the approved plan; a changed plan is refused at fulfill
 */
import { createHash } from "node:crypto";
import type { SpamActionRecord, SpamStore, TargetOrg } from "./store";

export type SpamAccountAction = "suspend" | "unsuspend" | "delete";
export const SPAM_ACCOUNT_ACTIONS: readonly SpamAccountAction[] = ["suspend", "unsuspend", "delete"];
export const SPAM_DELETE_MIN_DAYS = 7;
export const SPAM_MAX_ORGS_PER_REQUEST = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OrgPlan = {
  orgId: string;
  orgName: string;
  eligible: boolean;
  blockers: string[];
  userIds: string[];
  memberIds: string[];
};

export type SpamActionPlan = {
  action: SpamAccountAction;
  reason: string;
  orgs: OrgPlan[];
  eligibleCount: number;
  blockedCount: number;
  previewHash: string;
};

export type SpamActionInput = { action: SpamAccountAction; orgIds: string[]; reason: string };

export type ParsedSpamInput =
  | { ok: true; value: SpamActionInput }
  | { ok: false; code: string; message: string };

function idList(value: string | undefined): Set<string> {
  return new Set((value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function protectedOrgIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const ids = idList(env.SPAM_PROTECTED_ORG_IDS);
  const ops = (env.PLATFORM_OPS_ORG_ID || "").trim().toLowerCase();
  if (ops) ids.add(ops);
  return ids;
}

function protectedUserIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set([...idList(env.SUPER_ADMIN_USER_IDS), ...idList(env.SPAM_ACCOUNTS_APPROVER_USER_IDS)]);
}

export function parseSpamActionInput(action: SpamAccountAction, args: Record<string, unknown>): ParsedSpamInput {
  const raw = Array.isArray(args.orgIds) ? args.orgIds : [];
  const orgIds = [...new Set(raw.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean))];
  if (!orgIds.length) return { ok: false, code: "org_ids_required", message: "orgIds を1件以上指定してください" };
  if (orgIds.length > SPAM_MAX_ORGS_PER_REQUEST) {
    return { ok: false, code: "too_many_orgs", message: `orgIds は最大 ${SPAM_MAX_ORGS_PER_REQUEST} 件です` };
  }
  if (orgIds.some((id) => !UUID_RE.test(id))) return { ok: false, code: "invalid_org_id", message: "orgIds は UUID で指定してください" };
  const reason = String(args.reason ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (reason.length < 4 || reason.length > 500) {
    return { ok: false, code: "reason_required", message: "reason（4〜500文字）が必要です" };
  }
  return { ok: true, value: { action, orgIds: orgIds.sort(), reason } };
}

function latestAction(records: SpamActionRecord[], orgId: string): SpamActionRecord | null {
  const rows = records.filter((r) => r.orgId === orgId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return rows.length ? rows[rows.length - 1] : null;
}

function isBanned(bannedUntil: string | null, now: Date): boolean {
  if (!bannedUntil) return false;
  const t = Date.parse(bannedUntil);
  return Number.isFinite(t) && t > now.getTime();
}

export function computePreviewHash(action: SpamAccountAction, reason: string, orgs: OrgPlan[]): string {
  const canonical = {
    v: 1,
    action,
    reason,
    orgs: orgs
      .map((o) => ({ orgId: o.orgId, eligible: o.eligible, blockers: [...o.blockers].sort(),
        userIds: [...o.userIds].sort(), memberIds: [...o.memberIds].sort() }))
      .sort((a, b) => a.orgId.localeCompare(b.orgId)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function planOrg(
  action: SpamAccountAction,
  orgId: string,
  target: TargetOrg | undefined,
  records: SpamActionRecord[],
  now: Date,
  env: NodeJS.ProcessEnv = process.env
): OrgPlan {
  const blockers: string[] = [];
  if (!target) return { orgId, orgName: "", eligible: false, blockers: ["org_not_found"], userIds: [], memberIds: [] };
  const name = target.name.slice(0, 60);
  if (protectedOrgIds(env).has(orgId.toLowerCase())) blockers.push("protected_org");
  if (target.stripeCustomerId || target.hasStripeSubscription) blockers.push("has_billing");
  if (target.employeeCount > 0) blockers.push("has_ai_employees");
  if (target.members.length > 3) blockers.push("too_many_members");
  const pUsers = protectedUserIds(env);
  if (target.members.some((m) => m.userId && pUsers.has(m.userId.toLowerCase()))) blockers.push("protected_user");

  const userIds = [...new Set(target.members.map((m) => m.userId).filter((x): x is string => !!x))].sort();
  const usersById = new Map(target.users.map((u) => [u.userId, u]));
  if (userIds.some((id) => !usersById.has(id))) blockers.push("auth_user_missing");
  const last = latestAction(records, orgId);

  let memberIds: string[] = [];
  if (action === "suspend" || action === "delete") {
    if (target.users.some((u) => u.otherOrgIds.length > 0)) blockers.push("user_in_other_org");
  }
  if (action === "suspend") {
    memberIds = target.members.filter((m) => m.status === "active" || m.status === "invited").map((m) => m.memberId);
    const allBanned = userIds.every((id) => isBanned(usersById.get(id)?.bannedUntil ?? null, now));
    if (allBanned && memberIds.length === 0) blockers.push("already_suspended");
  } else if (action === "unsuspend") {
    if (!last || last.action !== "suspend") blockers.push("no_suspend_record");
    memberIds = target.members.filter((m) => m.status === "disabled").map((m) => m.memberId);
  } else {
    if (!last) blockers.push("no_suspend_record");
    else if (last.action !== "suspend") blockers.push(last.action === "unsuspend" ? "unsuspended_after_suspend" : "already_deleted");
    else if (now.getTime() - Date.parse(last.createdAt) < SPAM_DELETE_MIN_DAYS * 86400000) blockers.push("suspend_lt_7d");
    if (userIds.some((id) => !isBanned(usersById.get(id)?.bannedUntil ?? null, now))) blockers.push("user_not_banned");
    if (target.members.some((m) => m.status !== "disabled")) blockers.push("member_not_disabled");
    memberIds = target.members.map((m) => m.memberId);
  }
  return { orgId, orgName: name, eligible: blockers.length === 0, blockers, userIds, memberIds: memberIds.sort() };
}

export async function planSpamAction(
  store: SpamStore,
  input: SpamActionInput,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): Promise<SpamActionPlan> {
  const [targets, records] = await Promise.all([store.loadTargets(input.orgIds), store.listActions(input.orgIds)]);
  const byId = new Map(targets.map((t) => [t.orgId.toLowerCase(), t]));
  const orgs = input.orgIds.map((id) => planOrg(input.action, id, byId.get(id), records, now, env));
  const eligibleCount = orgs.filter((o) => o.eligible).length;
  return {
    action: input.action,
    reason: input.reason,
    orgs,
    eligibleCount,
    blockedCount: orgs.length - eligibleCount,
    previewHash: computePreviewHash(input.action, input.reason, orgs),
  };
}

export type SpamExecContext = {
  approvalId: string | null;
  approver: string | null;
  requestedBy: string | null;
  opsOrgId: string | null;
};

export type SpamExecResult = {
  ok: boolean;
  action: SpamAccountAction;
  processedOrgs: number;
  bannedUsers: number;
  unbannedUsers: number;
  membersChanged: number;
  deletedOrgs: number;
  deletedUsers: number;
  error?: string;
  failedOrgId?: string;
};

const AUDIT_ACTION = {
  suspend: "admin.spam_suspend",
  unsuspend: "admin.spam_unsuspend",
  delete: "admin.spam_delete",
} as const;

const ACTION_JA = { suspend: "停止", unsuspend: "停止解除", delete: "削除" } as const;

/** Executes an already-approved plan. Caller must have re-planned and matched previewHash. */
export async function executeSpamPlan(store: SpamStore, plan: SpamActionPlan, ctx: SpamExecContext): Promise<SpamExecResult> {
  const result: SpamExecResult = {
    ok: true, action: plan.action, processedOrgs: 0, bannedUsers: 0, unbannedUsers: 0,
    membersChanged: 0, deletedOrgs: 0, deletedUsers: 0,
  };
  if (plan.blockedCount > 0 || plan.eligibleCount === 0) {
    return { ...result, ok: false, error: plan.eligibleCount === 0 ? "no_eligible_targets" : "ineligible_targets" };
  }
  for (const org of plan.orgs) {
    try {
      const counts = { banned: 0, unbanned: 0, members: 0, deletedUsers: 0, deletedOrg: false };
      const userDeleteFailures: Array<{ userId: string; error: string }> = [];
      if (plan.action === "suspend") {
        // Ban first so no session can be refreshed while memberships flip.
        for (const uid of org.userIds) { await store.banUser(uid); counts.banned++; }
        counts.members += await store.setMemberStatus(org.memberIds, "active", "disabled");
        counts.members += await store.setMemberStatus(org.memberIds, "invited", "disabled");
      } else if (plan.action === "unsuspend") {
        for (const uid of org.userIds) { await store.unbanUser(uid); counts.unbanned++; }
        counts.members += await store.setMemberStatus(org.memberIds, "disabled", "active");
      } else {
        counts.deletedOrg = await store.deleteOrg(org.orgId);
        if (!counts.deletedOrg) throw new Error("org_delete_noop");
        // Org is gone: always write the ledger even if an auth user delete fails.
        for (const uid of org.userIds) {
          try { await store.deleteAuthUser(uid); counts.deletedUsers++; }
          catch (e) { userDeleteFailures.push({ userId: uid, error: e instanceof Error ? e.message : "delete_failed" }); }
        }
      }
      await store.insertAction({
        action: plan.action, orgId: org.orgId, userIds: org.userIds, approvalId: ctx.approvalId,
        approver: ctx.approver, requestedBy: ctx.requestedBy, previewHash: plan.previewHash,
        reason: plan.reason, details: { memberIds: org.memberIds, ...counts, userDeleteFailures },
      });
      if (plan.action !== "delete") {
        await store.appendAudit({
          orgId: org.orgId, action: AUDIT_ACTION[plan.action],
          summary: `スパム対策: アカウント${ACTION_JA[plan.action]}（承認済み）`,
          metadata: { approvalId: ctx.approvalId, approver: ctx.approver, previewHash: plan.previewHash,
            userIds: org.userIds, memberIds: org.memberIds, reason: plan.reason },
        });
      }
      result.processedOrgs++;
      result.bannedUsers += counts.banned;
      result.unbannedUsers += counts.unbanned;
      result.membersChanged += counts.members;
      result.deletedOrgs += counts.deletedOrg ? 1 : 0;
      result.deletedUsers += counts.deletedUsers;
      if (userDeleteFailures.length) throw new Error("auth_user_delete_failed");
    } catch (error) {
      result.ok = false;
      result.error = error instanceof Error ? error.message : "execute_failed";
      result.failedOrgId = org.orgId;
      break; // stop on first failure; ledger already has the completed orgs
    }
  }
  if (ctx.opsOrgId) {
    await store.appendAudit({
      orgId: ctx.opsOrgId, action: AUDIT_ACTION[plan.action],
      summary: `スパム対策: ${result.processedOrgs}/${plan.orgs.length} 組織のアカウント${ACTION_JA[plan.action]}${result.ok ? "" : "（途中で失敗）"}`,
      metadata: { approvalId: ctx.approvalId, approver: ctx.approver, previewHash: plan.previewHash,
        orgIds: plan.orgs.map((o) => o.orgId), result },
    }).catch(() => null);
  }
  return result;
}

/** Masked, LLM-safe view of a plan (no emails). */
export function publicPlan(plan: SpamActionPlan) {
  return {
    action: plan.action,
    reason: plan.reason,
    eligibleCount: plan.eligibleCount,
    blockedCount: plan.blockedCount,
    previewHash: plan.previewHash,
    orgs: plan.orgs.map((o) => ({ orgId: o.orgId, orgName: o.orgName, eligible: o.eligible, blockers: o.blockers,
      userCount: o.userIds.length, memberCount: o.memberIds.length })),
  };
}
