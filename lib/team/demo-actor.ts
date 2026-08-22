import {
  DEMO_ORG,
  getRuntimeMemberById,
  getRuntimeMembers,
} from "@/lib/demo-data";
import type { HumanCapability, OrgMember } from "@/lib/types";
import { hasCapability, missingCapabilityMessage } from "@/lib/team/rbac";
import { NextResponse } from "next/server";

export function resolveDemoActor(
  req: Request,
  bodyActorId?: string | null
): OrgMember {
  const headerId = req.headers.get("x-member-id") || "";
  const url = new URL(req.url);
  const queryId = url.searchParams.get("as") || "";
  const id = (bodyActorId || headerId || queryId || "mem_1").trim();
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

export function requireCapability(
  req: Request,
  cap: HumanCapability,
  bodyActorId?: string | null
): { ok: true; actor: OrgMember } | { ok: false; response: NextResponse } {
  const actor = resolveDemoActor(req, bodyActorId);
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
          demo: true,
        },
        { status: 403 }
      ),
    };
  }
  return { ok: true, actor };
}
