import { NextResponse } from "next/server";
import { assertWebActorApproverAuthority, webDirectDeniedBody, webSessionActorMemberId } from "@/lib/approver-authority/web-direct";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { getOrgSodWarnPolicy, setOrgSodWarnPolicy } from "@/lib/data";
import { policyErrorPayload } from "@/lib/employees/policy-errors";
import { normalizeSodWarnPolicy } from "@/lib/employees/sod-warn-policy";

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const policy = await getOrgSodWarnPolicy(gate.orgId);
  return NextResponse.json({ ok: true, policy });
}

export async function PUT(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // Review 2026-10-09 item 2: who must review which combinations is a permission setting.
  const authority = await assertWebActorApproverAuthority({
    orgId: gate.orgId,
    memberId: await webSessionActorMemberId(req),
    changes: [{ tool: "web.sodWarnPolicy", adminMutation: {}, kind: "owner_or_designated_admin" }],
    surface: "settings.sod_warn_policy",
  });
  if (!authority.ok) return NextResponse.json(webDirectDeniedBody(authority), { status: 403 });
  try {
    const policy = await setOrgSodWarnPolicy(gate.orgId, normalizeSodWarnPolicy(body));
    return NextResponse.json({ ok: true, policy });
  } catch {
    return NextResponse.json(policyErrorPayload("issue_failed", "組み合わせの保存に失敗しました"), {
      status: 500,
    });
  }
}
