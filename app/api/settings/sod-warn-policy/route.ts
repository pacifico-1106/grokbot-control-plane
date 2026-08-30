import { NextResponse } from "next/server";
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
  try {
    const policy = await setOrgSodWarnPolicy(gate.orgId, normalizeSodWarnPolicy(body));
    return NextResponse.json({ ok: true, policy });
  } catch {
    return NextResponse.json(policyErrorPayload("issue_failed", "組み合わせの保存に失敗しました"), {
      status: 500,
    });
  }
}
