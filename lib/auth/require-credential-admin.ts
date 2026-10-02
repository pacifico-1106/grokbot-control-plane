import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { isDemoMode } from "@/lib/mode";
import { requireCapability } from "@/lib/team/demo-actor";
import {
  CREDENTIAL_ADMIN_REQUIRED_MESSAGE_JA,
  CREDENTIAL_ADMIN_ROLES,
} from "@/lib/team/rbac";
import type { OrgMember } from "@/lib/types";

export { CREDENTIAL_ADMIN_ROLES };

export type CredentialAdminGate =
  | { ok: true; actor: OrgMember; orgId: string }
  | { ok: false; response: NextResponse };

/**
 * Gate for actions that put a usable secret (gb_emp_ / gb_adm_) or an
 * equivalent grant into someone's hands: owner/admin role AND
 * hire_issue_credentials capability.
 *
 * Production: a real Auth session with an active org membership is required
 * first (401 auth_required otherwise) so the capability check never runs
 * against the header/body actor fallback. Fails closed (403) when either the
 * role or the capability is missing.
 */
export async function requireCredentialAdmin(
  req: Request,
  bodyActorId?: string | null
): Promise<CredentialAdminGate> {
  let orgId: string | null = null;
  if (!isDemoMode()) {
    const session = await getSessionContext();
    if (!session.userId || !session.orgId || !session.member) {
      return {
        ok: false,
        response: NextResponse.json(
          { ok: false, error: "auth_required", message: "ログインと組織が必要です" },
          { status: 401 }
        ),
      };
    }
    orgId = session.orgId;
  }
  const gate = await requireCapability(req, "hire_issue_credentials", bodyActorId);
  if (!gate.ok) return gate;
  if (!CREDENTIAL_ADMIN_ROLES.includes(gate.actor.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: "role_denied",
          code: "owner_or_admin_required",
          message: CREDENTIAL_ADMIN_REQUIRED_MESSAGE_JA,
        },
        { status: 403 }
      ),
    };
  }
  return { ok: true, actor: gate.actor, orgId: orgId ?? gate.actor.orgId };
}
