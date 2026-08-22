import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  DEMO_ORG,
  getRuntimeMemberById,
  getRuntimeMembers,
  upsertRuntimeMember,
} from "@/lib/demo-data";
import { requireCapability } from "@/lib/team/demo-actor";
import type {
  HumanCapability,
  HumanJobRole,
  OrgMember,
  OrgMemberRole,
} from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, members: getRuntimeMembers(), demo: true });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string | null;
    email?: string;
    displayName?: string;
    role?: OrgMemberRole;
    jobRole?: HumanJobRole;
    jobLabel?: string | null;
    capabilities?: HumanCapability[];
    actorMemberId?: string | null;
  };

  const gate = requireCapability(req, "manage_team", body.actorMemberId);
  if (!gate.ok) return gate.response;

  const email = (body.email || "").trim();
  const displayName = (body.displayName || "").trim();
  if (!email || !displayName) {
    return NextResponse.json({ error: "name_and_email_required" }, { status: 400 });
  }

  const capabilities = [...new Set(body.capabilities || [])];
  if (!capabilities.length) {
    return NextResponse.json({ error: "capabilities_required" }, { status: 400 });
  }

  const existing = body.id ? getRuntimeMemberById(body.id) : null;
  const member: OrgMember = {
    id: existing?.id || `mem_${randomBytes(3).toString("hex")}`,
    orgId: DEMO_ORG.id,
    email,
    displayName,
    role: body.role || existing?.role || "member",
    jobRole: body.jobRole || "custom",
    jobLabel: body.jobLabel ?? null,
    capabilities,
    status: existing?.status || "invited",
  };

  upsertRuntimeMember(member);
  return NextResponse.json({
    ok: true,
    member,
    demo: true,
    actorId: gate.actor.id,
  });
}
