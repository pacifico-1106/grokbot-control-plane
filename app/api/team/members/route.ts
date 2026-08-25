import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireOrgSession } from "@/lib/auth/require-org";
import { getCurrentOrgId } from "@/lib/auth/session";
import { assertBillingAllows } from "@/lib/billing/entitlements";
import {
  getMemberById,
  listMembers,
  runtimeModeLabel,
  upsertMember,
} from "@/lib/data";
import { requireCapability } from "@/lib/team/demo-actor";
import type {
  HumanCapability,
  HumanJobRole,
  OrgMember,
  OrgMemberRole,
} from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;
  const members = await listMembers(gate.orgId);
  return NextResponse.json({
    ok: true,
    members,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
  });
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

  const gate = await requireCapability(req, "manage_team", body.actorMemberId);
  if (!gate.ok) return gate.response;

  const billingOrgId = await getCurrentOrgId();
  const billingGate = await assertBillingAllows(billingOrgId, "team");
  if (!billingGate.ok) return billingGate.response;

  const email = (body.email || "").trim();
  const displayName = (body.displayName || "").trim();
  if (!email || !displayName) {
    return NextResponse.json({ error: "name_and_email_required" }, { status: 400 });
  }

  const capabilities = [...new Set(body.capabilities || [])];
  if (!capabilities.length) {
    return NextResponse.json({ error: "capabilities_required" }, { status: 400 });
  }

  const orgId = await getCurrentOrgId();
  const existing = body.id ? await getMemberById(body.id, orgId) : null;
  const member: OrgMember = {
    id: existing?.id || `mem_${randomBytes(3).toString("hex")}`,
    orgId: orgId || existing?.orgId || "org_demo",
    email,
    displayName,
    role: body.role || existing?.role || "member",
    jobRole: body.jobRole || "custom",
    jobLabel: body.jobLabel ?? null,
    capabilities,
    status: existing?.status || "invited",
  };

  const saved = await upsertMember(member, orgId);
  return NextResponse.json({
    ok: true,
    member: saved,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    actorId: gate.actor.id,
  });
}
