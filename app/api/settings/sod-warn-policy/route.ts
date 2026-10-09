import { NextResponse } from "next/server";
import { assertWebActorApproverAuthority, webDirectDeniedBody, webSessionActorMemberId } from "@/lib/approver-authority/web-direct";
import { readPrevSodWarnPolicy, sodWarnPolicyChanged } from "@/lib/approver-authority/web-prev-state";
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
  const next = normalizeSodWarnPolicy(body);
  // Review 2026-10-09 item 2: who must review which combinations is a permission setting.
  // #279 decision 3 (木村 2026-10-09 22:48): gated only when the domains actually
  // change; an unreadable previous policy counts as changed.
  if (sodWarnPolicyChanged(await readPrevSodWarnPolicy(gate.orgId), next)) {
    const authority = await assertWebActorApproverAuthority({
      orgId: gate.orgId,
      memberId: await webSessionActorMemberId(req),
      changes: [{ tool: "web.sodWarnPolicy", adminMutation: {}, kind: "owner_or_designated_admin" }],
      surface: "settings.sod_warn_policy",
    });
    if (!authority.ok) return NextResponse.json(webDirectDeniedBody(authority), { status: 403 });
  }
  try {
    const policy = await setOrgSodWarnPolicy(gate.orgId, next);
    return NextResponse.json({ ok: true, policy });
  } catch {
    return NextResponse.json(policyErrorPayload("issue_failed", "組み合わせの保存に失敗しました"), {
      status: 500,
    });
  }
}
