import type { SessionContext } from "@/lib/auth/session";
import { IDENTITY_LINK_CAPABILITY } from "@/lib/auth/identity-link-gate";
import { hasCapability } from "@/lib/team/rbac";

export type IdentityLinkPermissions = {
  /**
   * Slack / Google identity connect + disconnect for an AI employee
   * (/api/slack/oauth/start, /api/google/oauth/start|disconnect,
   * PATCH / DELETE /api/employees/[id]/slack-identity) → hire_issue_credentials.
   */
  canManageIdentityLinks: boolean;
};

/**
 * Server-side decision mirroring the API gate so a session never sees a
 * connect / disconnect control its request would be refused for. The API gate
 * stays authoritative. Demo sessions follow the existing page convention
 * (session.demo → allowed; the demo API resolves the in-memory owner).
 */
export function identityLinkPermissions(session: SessionContext): IdentityLinkPermissions {
  if (session.demo) return { canManageIdentityLinks: true };
  const member = session.userId && session.orgId ? session.member : null;
  if (!member || member.orgId !== session.orgId || member.status !== "active") {
    return { canManageIdentityLinks: false };
  }
  return { canManageIdentityLinks: hasCapability(member, IDENTITY_LINK_CAPABILITY) };
}
