import {
  DEMO_ORG,
  getRuntimeMemberById,
  getRuntimeMembers,
} from "@/lib/demo-data";
import { getSessionContext } from "@/lib/auth/session";
import { isDemoMode } from "@/lib/mode";
import type { HumanCapability, OrgMember } from "@/lib/types";
import { hasCapability, missingCapabilityMessage } from "@/lib/team/rbac";
import { NextResponse } from "next/server";

function actorIdFromRequest(
  req: Request,
  bodyActorId?: string | null
): string {
  const headerId = req.headers.get("x-member-id") || "";
  const url = new URL(req.url);
  const queryId = url.searchParams.get("as") || "";
  return (bodyActorId || headerId || queryId || "mem_1").trim();
}

export const ACTIVE_MEMBER_REQUIRED_MESSAGE_JA =
  "ログインと組織メンバーシップが必要です。再ログインしてください。";

/** Production: no session / no active org_members row for the session org. */
function activeMemberRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "auth_required",
      code: "active_member_required",
      message: ACTIVE_MEMBER_REQUIRED_MESSAGE_JA,
    },
    { status: 401 }
  );
}

/** DEMO-only sync resolver (in-memory members). */
export function resolveDemoActor(
  req: Request,
  bodyActorId?: string | null
): OrgMember {
  const id = actorIdFromRequest(req, bodyActorId);
  return (
    getRuntimeMemberById(id) ??
    getRuntimeMembers().find((m) => m.role === "owner") ??
    getRuntimeMembers()[0] ?? {
      id: "mem_1",
      orgId: DEMO_ORG.id,
      email: "owner@example.com",
      displayName: "山田 太郎",
      role: "owner",
      jobRole: "owner",
      capabilities: [
        "view_dashboard",
        "view_employees",
        "view_audit",
        "approve_actions",
        "manage_spend_limits",
        "hire_issue_credentials",
        "manage_team",
        "manage_billing",
      ],
      status: "active",
    }
  );
}

/**
 * Capability gate.
 *
 * DEMO (isDemoMode()): the in-memory demo actor chosen by body actorMemberId /
 * x-member-id / ?as= (default mem_1). Demo has no Auth; unchanged.
 *
 * Production: ONLY the session's own active org_members row. Fails closed —
 * no session, no active member row, or a member row that does not belong to
 * the session org → 401 auth_required (same contract as requireOrgSession /
 * requireCredentialAdmin). There is no owner fallback and x-member-id / ?as= /
 * body actorMemberId are ignored. Missing capability → 403 capability_denied.
 */
export async function requireCapability(
  req: Request,
  cap: HumanCapability,
  bodyActorId?: string | null
): Promise<
  { ok: true; actor: OrgMember } | { ok: false; response: NextResponse }
> {
  let actor: OrgMember;

  if (isDemoMode()) {
    actor = resolveDemoActor(req, bodyActorId);
  } else {
    const session = await getSessionContext();
    const member = session.member;
    if (
      !session.userId ||
      !session.orgId ||
      !member ||
      member.orgId !== session.orgId ||
      member.status !== "active"
    ) {
      return { ok: false, response: activeMemberRequiredResponse() };
    }
    actor = member;
  }

  if (!hasCapability(actor, cap)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: "capability_denied",
          code: cap,
          message: missingCapabilityMessage(cap),
          actorId: actor.id,
          actorEmail: actor.email,
          demo: isDemoMode(),
        },
        { status: 403 }
      ),
    };
  }
  return { ok: true, actor };
}
