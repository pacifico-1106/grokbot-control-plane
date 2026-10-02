import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/team/demo-actor";
import type { OrgMember } from "@/lib/types";

/** Org roles allowed to mint / re-mint / bind 社員証 (employee credentials). */
export const CREDENTIAL_ADMIN_ROLES: ReadonlyArray<OrgMember["role"]> = ["owner", "admin"];

export type CredentialAdminGate =
  | { ok: true; actor: OrgMember }
  | { ok: false; response: NextResponse };

/**
 * Gate for actions that put a usable employee secret (or an equivalent grant)
 * into someone's hands: owner/admin role AND hire_issue_credentials capability.
 * Fails closed (403) when either is missing.
 */
export async function requireCredentialAdmin(
  req: Request,
  bodyActorId?: string | null
): Promise<CredentialAdminGate> {
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
          message: "社員証の再発行はオーナーまたは管理者のみ実行できます。",
        },
        { status: 403 }
      ),
    };
  }
  return gate;
}
