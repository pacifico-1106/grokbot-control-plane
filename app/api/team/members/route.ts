import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { requireOrgSession } from "@/lib/auth/require-org";
import { assertBillingAllows } from "@/lib/billing/entitlements";
import {
  getMemberById,
  isUuid,
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

function memberErrorMessage(raw: string): string {
  switch (raw) {
    case "org_id_required":
      return "組織が特定できません";
    case "supabase_not_configured":
      return "データベースが未設定です";
    case "member_upsert_failed":
      return "メンバーの保存に失敗しました";
    case "member_list_failed":
      return "メンバー一覧の取得に失敗しました";
    default:
      return raw;
  }
}

export async function GET() {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;
  try {
    const members = await listMembers(gate.orgId);
    return NextResponse.json({
      ok: true,
      members,
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : "member_list_failed";
    return NextResponse.json(
      { ok: false, error: raw, message: memberErrorMessage(raw) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;

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

  const cap = await requireCapability(req, "manage_team", body.actorMemberId);
  if (!cap.ok) return cap.response;

  const billingGate = await assertBillingAllows(gate.orgId, "team");
  if (!billingGate.ok) return billingGate.response;

  const email = (body.email || "").trim().toLowerCase();
  const displayName = (body.displayName || "").trim();
  if (!email || !displayName) {
    return NextResponse.json(
      { error: "name_and_email_required", message: "名前とメールは必須です" },
      { status: 400 }
    );
  }

  const capabilities = [...new Set(body.capabilities || [])];
  if (!capabilities.length) {
    return NextResponse.json(
      { error: "capabilities_required", message: "権限を1つ以上選んでください" },
      { status: 400 }
    );
  }

  try {
    const bodyId = typeof body.id === "string" ? body.id.trim() : "";
    const existing = bodyId ? await getMemberById(bodyId, gate.orgId) : null;
    const member: OrgMember = {
      id:
        existing?.id ||
        (isUuid(bodyId) ? bodyId : crypto.randomUUID()),
      orgId: gate.orgId,
      email,
      displayName,
      role: body.role || existing?.role || "member",
      jobRole: body.jobRole || "custom",
      jobLabel: body.jobLabel ?? null,
      capabilities,
      status: existing?.status || "invited",
    };

    const saved = await upsertMember(member, gate.orgId);
    revalidatePath("/app/team");
    return NextResponse.json({
      ok: true,
      member: saved,
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
      actorId: cap.actor.id,
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : "member_upsert_failed";
    const status =
      raw === "org_id_required" || raw === "name_and_email_required" ? 400 : 500;
    return NextResponse.json(
      { ok: false, error: raw, message: memberErrorMessage(raw) },
      { status }
    );
  }
}
