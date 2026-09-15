/**
 * Fail-closed gate for platform-level Admin MCP tools (orgs.create / orgs.status).
 * Tenant-scoped gb_adm_ alone is insufficient — caller org must be platform ops.
 */
import { matchesSuperAdminAllowlist } from "@/lib/admin/allowlist";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
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

function ownerMatchesSuperAdminAllowlist(owner: { email: string }): boolean {
  const email = owner.email.trim();
  if (!email) return false;
  return matchesSuperAdminAllowlist({
    userId: "unknown",
    email,
    userIds: process.env.SUPER_ADMIN_USER_IDS,
    emails: process.env.SUPER_ADMIN_EMAILS,
  });
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

  const matchedOwner = owners.find((owner) => ownerMatchesSuperAdminAllowlist(owner));
  if (!matchedOwner) {
    return {
      allowed: false,
      code: "platform_ops_forbidden",
      message:
        "orgs.create / orgs.status は SUPER_ADMIN allowlist 上の org owner のみ利用できます（fail-closed）",
    };
  }

  return {
    allowed: true,
    actor: {
      email: matchedOwner.email,
      userId: null,
      orgId: cred.orgId,
    },
  };
}
