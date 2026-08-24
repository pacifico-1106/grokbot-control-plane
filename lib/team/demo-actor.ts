import {
  DEMO_ORG,
  getRuntimeMemberById,
  getRuntimeMembers,
} from "@/lib/demo-data";
import { getSessionContext } from "@/lib/auth/session";
import { resolveActorMember } from "@/lib/data/members";
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
 * Capability gate: DEMO → in-memory mem_*; production → session member
 * (falls back to org owner via resolveActorMember).
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
    if (session.member) {
      actor = session.member;
    } else {
      const headerOrBody = actorIdFromRequest(req, bodyActorId);
      const id =
        headerOrBody === "mem_1" && !bodyActorId && !req.headers.get("x-member-id")
          ? null
          : headerOrBody;
      actor = await resolveActorMember(id, session.orgId);
    }
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
