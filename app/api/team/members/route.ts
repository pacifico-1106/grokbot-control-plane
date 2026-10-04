import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { requireOrgSession } from "@/lib/auth/require-org";
import { sendMemberInviteEmail } from "@/lib/auth/invite-email";
import { assertBillingAllows } from "@/lib/billing/entitlements";
import { listMembers, runtimeModeLabel } from "@/lib/data";
import {
  applyMemberChange,
  resolveMemberChangeActor,
  teamEditability,
} from "@/lib/team/apply-member-change";
import type { HumanJobRole } from "@/lib/types";

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

export async function GET(req: Request) {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;
  try {
    const members = await listMembers(gate.orgId);
    // Checkbox state only; POST re-evaluates every change server-side.
    const viewer = await resolveMemberChangeActor(req).catch(() => null);
    const actor = viewer?.ok ? viewer.actor : null;
    const editability = teamEditability(actor, members, viewer?.ok ? viewer.authEmail : null);
    return NextResponse.json({
      ok: true,
      members: members.map((m) => ({ ...m, editable: editability.byMemberId[m.id] })),
      viewer: actor ? { id: actor.id, role: actor.role } : null,
      inviteEditable: editability.invite,
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
    role?: unknown;
    jobRole?: HumanJobRole;
    jobLabel?: string | null;
    capabilities?: unknown;
    actorMemberId?: string | null;
  };

  // Production: session member only (body/header actor ids ignored). DEMO: demo actor.
  const who = await resolveMemberChangeActor(req, body.actorMemberId);
  if (!who.ok) {
    return NextResponse.json(
      { ok: false, error: who.error, code: who.code, message: who.messageJa },
      { status: who.httpStatus }
    );
  }

  const billingGate = await assertBillingAllows(gate.orgId, "team");
  if (!billingGate.ok) return billingGate.response;

  const email = (typeof body.email === "string" ? body.email : "").trim().toLowerCase();
  const displayName = (typeof body.displayName === "string" ? body.displayName : "").trim();
  if (!email || !displayName) {
    return NextResponse.json(
      { error: "name_and_email_required", message: "名前とメールは必須です" },
      { status: 400 }
    );
  }

  const capabilities = Array.isArray(body.capabilities) ? [...new Set(body.capabilities)] : [];
  if (!capabilities.length) {
    return NextResponse.json(
      { error: "capabilities_required", message: "権限を1つ以上選んでください" },
      { status: 400 }
    );
  }

  try {
    const result = await applyMemberChange({
      orgId: gate.orgId,
      actor: who.actor,
      actorAuthEmail: who.authEmail,
      targetId: typeof body.id === "string" ? body.id : null,
      email,
      displayName,
      role: body.role,
      jobRole: body.jobRole,
      jobLabel: body.jobLabel ?? null,
      capabilities,
      source: "team_api",
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result.code,
          code: result.code,
          message: result.messageJa,
          ...(result.capabilities ? { capabilities: result.capabilities } : {}),
        },
        { status: result.httpStatus }
      );
    }
    revalidatePath("/app/team");
    // NEW invite only (never on edits): Supabase invite email, flag-gated.
    const inviteEmail = result.before
      ? "disabled"
      : await sendMemberInviteEmail({
          orgId: gate.orgId,
          memberId: result.member.id,
          email: result.member.email,
          actorEmail: who.actor.email,
        });
    return NextResponse.json({
      ok: true,
      member: result.member,
      ...(inviteEmail !== "disabled" ? { inviteEmail } : {}),
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
      actorId: who.actor.id,
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
