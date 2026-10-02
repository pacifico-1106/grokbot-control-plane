/**
 * Fulfill-time approver check for accounts.suspend / unsuspend / delete.
 *
 * Only Auth user ids in SPAM_ACCOUNTS_APPROVER_USER_IDS (八坂) may approve.
 * approval.resolvedBy is the resolving member's profile email (dashboard) or a
 * channel actor string ("slack:U…", "telegram:…", "line:…"). Channel actors never
 * match. Profile email is editable, so it is only used to FIND candidates; the
 * decision is made on org_members.user_id + Supabase Auth (confirmed email equal
 * to resolvedBy, not banned). Any ambiguity fails closed.
 */
import { isDemoMode } from "@/lib/mode";
import { listMembers } from "@/lib/data/members";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { ApprovalRequest, OrgMember } from "@/lib/types";

export type ApproverAuthUser = { id: string; email: string | null; emailConfirmedAt: string | null; bannedUntil: string | null };
export type ApproverDeps = {
  listMembers: (orgId: string) => Promise<OrgMember[]>;
  getAuthUser: (userId: string) => Promise<ApproverAuthUser | null>;
  demo: boolean;
  now: Date;
};

export type ApproverCheck =
  | { ok: true; approverUserId: string }
  | { ok: false; code: string };

function defaultDeps(): ApproverDeps {
  return {
    listMembers: (orgId) => listMembers(orgId),
    getAuthUser: async (userId) => {
      const admin = createSupabaseAdminClient();
      if (!admin) return null;
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      const u = data.user as unknown as { id: string; email?: string | null; email_confirmed_at?: string | null; banned_until?: string | null };
      return { id: u.id, email: u.email ?? null, emailConfirmedAt: u.email_confirmed_at ?? null, bannedUntil: u.banned_until ?? null };
    },
    demo: isDemoMode(),
    now: new Date(),
  };
}

export function spamApproverUserIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.SPAM_ACCOUNTS_APPROVER_USER_IDS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export async function checkSpamApprover(
  approval: Pick<ApprovalRequest, "orgId" | "resolvedBy" | "status">,
  overrides: Partial<ApproverDeps> = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<ApproverCheck> {
  const deps = { ...defaultDeps(), ...overrides };
  if (approval.status !== "approved") return { ok: false, code: "not_approved" };
  const allow = spamApproverUserIds(env);
  if (!allow.size) return { ok: false, code: "approver_not_configured" };
  const opsOrg = (env.PLATFORM_OPS_ORG_ID || "").trim().toLowerCase();
  if (!opsOrg) return { ok: false, code: "platform_ops_not_configured" };
  if ((approval.orgId || "").toLowerCase() !== opsOrg) return { ok: false, code: "approval_not_in_ops_org" };

  const resolvedBy = (approval.resolvedBy || "").trim().toLowerCase();
  if (!resolvedBy || /^(slack|telegram|line|web|system|cron|admin_mcp)[:]/.test(resolvedBy) || !/^[^@\s:]+@[^@\s]+$/.test(resolvedBy)) {
    return { ok: false, code: "approver_channel_not_allowed" };
  }

  const members = (await deps.listMembers(opsOrg)).filter(
    (m) => (m.email || "").trim().toLowerCase() === resolvedBy
  );
  if (!members.length) return { ok: false, code: "approver_not_member" };
  if (members.length !== 1) return { ok: false, code: "approver_ambiguous" };
  const member = members[0];
  if (member.status !== "active") return { ok: false, code: "approver_inactive" };
  const userId = (member.userId || "").trim().toLowerCase();
  if (!userId || !allow.has(userId)) return { ok: false, code: "approver_not_allowlisted" };

  if (!deps.demo) {
    const user = await deps.getAuthUser(userId);
    if (!user || user.id.toLowerCase() !== userId) return { ok: false, code: "approver_auth_missing" };
    if (!user.emailConfirmedAt) return { ok: false, code: "approver_email_unconfirmed" };
    if ((user.email || "").trim().toLowerCase() !== resolvedBy) return { ok: false, code: "approver_email_mismatch" };
    if (user.bannedUntil && Date.parse(user.bannedUntil) > deps.now.getTime()) return { ok: false, code: "approver_banned" };
  }
  return { ok: true, approverUserId: userId };
}
