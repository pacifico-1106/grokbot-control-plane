import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { appendAuditEvent, terminateEmployee } from "@/lib/data";
import { requireCapability } from "@/lib/team/demo-actor";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireCapability(
    req,
    "hire_issue_credentials",
    typeof rawBody.actorMemberId === "string" ? rawBody.actorMemberId : null
  );
  if (!gate.ok) return gate.response;
  const orgId = await getCurrentOrgId();
  if (!orgId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  const { id } = await ctx.params;
  const employee = await terminateEmployee({ orgId, employeeId: id });
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  await appendAuditEvent({
    orgId,
    employeeId: id,
    credentialId: employee.credentialId,
    actorEmail: gate.actor.email,
    action: "credential.revoked",
    purpose: null,
    summary: `${employee.displayName} の社員証を失効`,
    metadata: { reason: "terminate" },
  });
  await appendAuditEvent({
    orgId,
    employeeId: id,
    credentialId: employee.credentialId,
    actorEmail: gate.actor.email,
    action: "employee.terminated",
    purpose: null,
    summary: `${employee.displayName} の契約を終了（社員証失効・停止。番号と監査は残す）`,
    metadata: { status: employee.status },
  });

  return NextResponse.json({ ok: true, employee });
}
