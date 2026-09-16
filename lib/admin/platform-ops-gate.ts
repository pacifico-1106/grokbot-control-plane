/**
 * Fail-closed gate for platform-level Admin MCP tools (orgs.create / orgs.status / orgs.issueAdminCredential).
 * Tenant-scoped gb_adm_ alone is insufficient — caller org must be platform ops.
 */
import { matchesSuperAdminAllowlist } from "@/lib/admin/allowlist";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { listMembers } from "@/lib/data/members";

export type PlatformOpsActor = {
  email: string;
  userId: string | null;
  orgId: string;
};

export type PlatformOpsGateResult =
  | { allowed: true; actor: PlatformOpsActor }
  | {
      allowed: false;
      code: "platform_ops_forbidden";
      message: string;
    };

function configuredPlatformOpsOrgId(): string | null {
  const value = (process.env.PLATFORM_OPS_ORG_ID || "").trim();
  return value || null;
}

/**
 * Returns whether the admin MCP credential may invoke platform ops tools.
 * Fail-closed: empty allowlists and unset PLATFORM_OPS_ORG_ID → deny.
 */
export async function assertPlatformOpsFromAdminCred(
  cred: ResolvedAdminCredential
): Promise<PlatformOpsGateResult> {
  const platformOrgId = configuredPlatformOpsOrgId();
  if (platformOrgId && cred.orgId !== platformOrgId) {
    return {
      allowed: false,
      code: "platform_ops_forbidden",
      message:
        "プラットフォーム運用ツールは PLATFORM_OPS_ORG_ID の org からのみ呼び出せます（fail-closed）",
    };
  }

  const members = await listMembers(cred.orgId);
  const owners = members.filter(
    (member) => member.role === "owner" && member.status === "active"
  );

  // org_members.email is editable profile data, never an authentication identity.
  const admin = isDemoMode() ? null : createSupabaseAdminClient();
  let matchedOwner: { email: string; userId: string } | null = null;
  for (const owner of owners) {
    let identity: { email: string; userId: string } | null = null;
    if (isDemoMode()) {
      identity = { email: owner.email, userId: owner.userId || owner.id };
    } else if (admin && owner.userId) {
      const { data, error } = await admin.auth.admin.getUserById(owner.userId);
      const user = data?.user;
      if (!error && user && user.id === owner.userId &&
          !(user.banned_until && Date.parse(user.banned_until) > Date.now()) &&
          !(user as unknown as { deleted_at?: string }).deleted_at) {
        identity = { userId: user.id, email: user.email_confirmed_at ? user.email || "" : "" };
      }
    }
    if (identity && matchesSuperAdminAllowlist({ ...identity,
      userIds: process.env.SUPER_ADMIN_USER_IDS, emails: process.env.SUPER_ADMIN_EMAILS,
    })) { matchedOwner = identity; break; }
  }
  if (!matchedOwner) {
    return {
      allowed: false,
      code: "platform_ops_forbidden",
      message:
        "プラットフォーム運用ツール（orgs.create / orgs.status / orgs.issueAdminCredential）は SUPER_ADMIN allowlist 上の org owner のみ利用できます（fail-closed）",
    };
  }

  return {
    allowed: true,
    actor: {
      email: matchedOwner.email,
      userId: matchedOwner.userId,
      orgId: cred.orgId,
    },
  };
}
