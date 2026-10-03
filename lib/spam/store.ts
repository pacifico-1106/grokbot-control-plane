/**
 * Data access for the spam sweep. All writes go through this interface so the
 * planner / executor are unit-testable with an in-memory fake.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { AuditAction } from "@/lib/types";
import type { SpamFacts } from "./score";

export type TargetMember = { memberId: string; userId: string | null; role: string; status: string };
export type TargetUser = {
  userId: string;
  bannedUntil: string | null;
  /** Memberships (any status) in orgs OUTSIDE the target set. */
  otherOrgIds: string[];
};
export type TargetOrg = {
  orgId: string;
  name: string;
  referralCode: string | null;
  stripeCustomerId: string | null;
  hasStripeSubscription: boolean;
  employeeCount: number;
  members: TargetMember[];
  users: TargetUser[];
};
export type SpamActionRow = {
  action: "suspend" | "unsuspend" | "delete";
  orgId: string;
  userIds: string[];
  approvalId: string | null;
  approver: string | null;
  requestedBy: string | null;
  previewHash: string | null;
  reason: string | null;
  details: Record<string, unknown>;
};
export type SpamActionRecord = { orgId: string; action: SpamActionRow["action"]; createdAt: string };
export type SpamAuditInput = { orgId: string; action: AuditAction; summary: string; metadata: Record<string, unknown> };

export interface SpamStore {
  scanFacts(days: number): Promise<SpamFacts[]>;
  loadTargets(orgIds: string[]): Promise<TargetOrg[]>;
  listActions(orgIds: string[]): Promise<SpamActionRecord[]>;
  banUser(userId: string): Promise<void>;
  unbanUser(userId: string): Promise<void>;
  setMemberStatus(memberIds: string[], from: string, to: string): Promise<number>;
  deleteOrg(orgId: string): Promise<boolean>;
  deleteAuthUser(userId: string): Promise<void>;
  insertAction(row: SpamActionRow): Promise<void>;
  insertReport(row: { trigger: "cron" | "admin_mcp"; windowDays: number; candidateCount: number; watchCount: number; report: unknown }): Promise<string | null>;
  setReportProposal(reportId: string, approvalId: string): Promise<void>;
  appendAudit(input: SpamAuditInput): Promise<void>;
}

/** Supabase Auth ban duration used for suspension (~100 years). */
export const SPAM_BAN_DURATION = "876000h";

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function createSupabaseSpamStore(): SpamStore | null {
  let admin: ReturnType<typeof createSupabaseAdminClient> = null;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) return null;
  const db = admin;

  return {
    async scanFacts(days) {
      const { data, error } = await db.rpc("spam_scan_facts", { p_days: days });
      if (error) throw new Error(error.message);
      return ((data as Record<string, unknown>[]) || []).map((r) => ({
        orgId: String(r.org_id),
        orgName: String(r.org_name ?? ""),
        orgCreatedAt: String(r.org_created_at ?? ""),
        referralCode: str(r.referral_code),
        stripeCustomerId: str(r.stripe_customer_id),
        hasStripeSubscription: r.has_stripe_subscription === true,
        memberCount: Number(r.member_count ?? 0),
        employeeCount: Number(r.employee_count ?? 0),
        sameName24h: Number(r.same_name_24h ?? 0),
        ownerMemberId: str(r.owner_member_id),
        ownerUserId: str(r.owner_user_id),
        ownerMemberStatus: str(r.owner_member_status),
        ownerEmail: str(r.owner_email),
        userCreatedAt: str(r.user_created_at),
        lastSignInAt: str(r.last_sign_in_at),
        bannedUntil: str(r.banned_until),
        signupSignals: Array.isArray(r.signup_signals) ? (r.signup_signals as string[]) : [],
        signupIpReuse: Number(r.signup_ip_reuse ?? 0),
      }));
    },

    async loadTargets(orgIds) {
      if (!orgIds.length) return [];
      const [{ data: orgs, error: oe }, { data: members, error: me }, { data: subs, error: se }, { data: emps, error: ee }] =
        await Promise.all([
          db.from("orgs").select("id,name,referral_code,stripe_customer_id").in("id", orgIds),
          db.from("org_members").select("id,org_id,user_id,role,status").in("org_id", orgIds),
          db.from("subscriptions").select("org_id,stripe_subscription_id").in("org_id", orgIds),
          db.from("employees").select("id,org_id").in("org_id", orgIds),
        ]);
      const err = oe || me || se || ee;
      if (err) throw new Error(err.message);
      const userIds = [...new Set((members || []).map((m) => m.user_id as string | null).filter((x): x is string => !!x))];
      const others = userIds.length
        ? await db.from("org_members").select("user_id,org_id,status").in("user_id", userIds)
        : { data: [], error: null };
      if (others.error) throw new Error(others.error.message);
      const users = new Map<string, TargetUser>();
      for (const uid of userIds) {
        const { data, error } = await db.auth.admin.getUserById(uid);
        if (error) throw new Error(error.message);
        users.set(uid, {
          userId: uid,
          bannedUntil: (data.user as unknown as { banned_until?: string | null })?.banned_until ?? null,
          otherOrgIds: (others.data || [])
            .filter((o) => o.user_id === uid && !orgIds.includes(String(o.org_id)))
            .map((o) => String(o.org_id)),
        });
      }
      return (orgs || []).map((o) => {
        const ms = (members || []).filter((m) => m.org_id === o.id);
        return {
          orgId: String(o.id),
          name: String(o.name ?? ""),
          referralCode: str(o.referral_code),
          stripeCustomerId: str(o.stripe_customer_id),
          hasStripeSubscription: (subs || []).some((s) => s.org_id === o.id && s.stripe_subscription_id),
          employeeCount: (emps || []).filter((e) => e.org_id === o.id).length,
          members: ms.map((m) => ({ memberId: String(m.id), userId: str(m.user_id), role: String(m.role), status: String(m.status) })),
          users: ms.map((m) => (m.user_id ? users.get(String(m.user_id)) : undefined)).filter((u): u is TargetUser => !!u),
        };
      });
    },

    async listActions(orgIds) {
      if (!orgIds.length) return [];
      const { data, error } = await db.from("spam_account_actions").select("org_id,action,created_at").in("org_id", orgIds).order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data || []).map((r) => ({ orgId: String(r.org_id), action: r.action as SpamActionRecord["action"], createdAt: String(r.created_at) }));
    },

    async banUser(userId) {
      const { error } = await db.auth.admin.updateUserById(userId, { ban_duration: SPAM_BAN_DURATION });
      if (error) throw new Error(error.message);
    },
    async unbanUser(userId) {
      const { error } = await db.auth.admin.updateUserById(userId, { ban_duration: "none" });
      if (error) throw new Error(error.message);
    },
    async setMemberStatus(memberIds, from, to) {
      if (!memberIds.length) return 0;
      const { data, error } = await db.from("org_members").update({ status: to }).in("id", memberIds).eq("status", from).select("id");
      if (error) throw new Error(error.message);
      return (data || []).length;
    },
    async deleteOrg(orgId) {
      const { data, error } = await db.from("orgs").delete().eq("id", orgId).select("id");
      if (error) throw new Error(error.message);
      return (data || []).length === 1;
    },
    async deleteAuthUser(userId) {
      const { error } = await db.auth.admin.deleteUser(userId, false);
      if (error) throw new Error(error.message);
    },
    async insertAction(row) {
      const { error } = await db.from("spam_account_actions").insert({
        action: row.action, org_id: row.orgId, user_ids: row.userIds, approval_id: row.approvalId,
        approver: row.approver, requested_by: row.requestedBy, preview_hash: row.previewHash,
        reason: row.reason, details: row.details,
      });
      if (error) throw new Error(error.message);
    },
    async insertReport(row) {
      const { data, error } = await db.from("spam_sweep_reports").insert({
        trigger: row.trigger, window_days: row.windowDays, candidate_count: row.candidateCount,
        watch_count: row.watchCount, report: row.report,
      }).select("id").single();
      if (error) throw new Error(error.message);
      return data ? String((data as { id: string }).id) : null;
    },
    async setReportProposal(reportId, approvalId) {
      const { error } = await db.from("spam_sweep_reports").update({ proposal_approval_id: approvalId }).eq("id", reportId);
      if (error) throw new Error(error.message);
    },
    async appendAudit(input) {
      await appendAuditEvent({
        orgId: input.orgId, employeeId: null, credentialId: null,
        action: input.action, purpose: input.action, summary: input.summary,
        metadata: { auditClass: "admin", ...input.metadata },
      });
    },
  };
}
