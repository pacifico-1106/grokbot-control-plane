import "server-only";

import { cache } from "react";
import { getSessionContext } from "@/lib/auth/session";
import { matchesSuperAdminAllowlist } from "@/lib/admin/allowlist";

declare const superAdminActorBrand: unique symbol;

export type SuperAdminActor = {
  userId: string;
  email: string;
  readonly [superAdminActorBrand]: true;
};

export type SuperAdminAccess =
  | { allowed: true; actor: SuperAdminActor }
  | { allowed: false; reason: "demo" | "unauthenticated" | "forbidden" };

/**
 * Platform-level access is deliberately separate from tenant owner/admin roles.
 * Supabase getUser() in getSessionContext verifies the session server-side.
 */
export const getSuperAdminAccess = cache(async (): Promise<SuperAdminAccess> => {
  const session = await getSessionContext();
  if (session.demo) return { allowed: false, reason: "demo" };
  if (!session.userId || !session.email) {
    return { allowed: false, reason: "unauthenticated" };
  }

  const allowed = matchesSuperAdminAllowlist({
    userId: session.userId,
    email: session.email,
    userIds: process.env.SUPER_ADMIN_USER_IDS,
    emails: process.env.SUPER_ADMIN_EMAILS,
  });

  if (!allowed) return { allowed: false, reason: "forbidden" };

  return {
    allowed: true,
    actor: {
      userId: session.userId,
      email: session.email,
    } as SuperAdminActor,
  };
});
