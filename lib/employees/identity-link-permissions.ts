import type { SessionContext } from "@/lib/auth/session";

// TDD compile stub (PR-SEC2): replaced by the real decision in the fix commit.
export function identityLinkPermissions(_session: SessionContext): { canManageIdentityLinks: boolean } {
  return { canManageIdentityLinks: true };
}
