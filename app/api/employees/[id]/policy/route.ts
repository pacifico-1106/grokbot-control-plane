import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { appendAuditEvent, updateEmployeePolicy } from "@/lib/data";
import { normalizeActionLimits } from "@/lib/action-gate";
import { requireCapability } from "@/lib/team/demo-actor";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { normalizeVoice } from "@/lib/employees/voice";
import { normalizeProjectAccess } from "@/lib/employees/project-access";
import { normalizeEmployeeIdentityField } from "@/lib/employees/identity";
import type { ApprovalPolicy, EmployeeScope } from "@/lib/types";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireCapability(req, "hire_issue_credentials", typeof body.actorMemberId === "string" ? body.actorMemberId : null);
  if (!gate.ok) return gate.response;
  const orgId = await getCurrentOrgId();
  if (!orgId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  const { id } = await ctx.params;
  const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) as EmployeeScope[] : [];
  const allowedPurposes = Array.isArray(body.allowedPurposes) ? body.allowedPurposes.map(String).filter(Boolean) : [];
  const approvalPolicy = body.approvalPolicy as ApprovalPolicy;
  if (!scopes.length || scopes.some((scope) => !ALL_SCOPES.includes(scope)) || !["auto", "risk_based", "always_human"].includes(approvalPolicy)) {
    return NextResponse.json({ error: "invalid_policy" }, { status: 400 });
  }
  let displayName: string | undefined;
  let roleLabel: string | undefined;
  if (body.displayName !== undefined) {
    displayName = normalizeEmployeeIdentityField(body.displayName);
    if (!displayName) return NextResponse.json({ error: "invalid_identity" }, { status: 400 });
  }
  if (body.roleLabel !== undefined) {
    roleLabel = normalizeEmployeeIdentityField(body.roleLabel);
    if (!roleLabel) return NextResponse.json({ error: "invalid_identity" }, { status: 400 });
  }
  const updated = await updateEmployeePolicy({
    orgId,
    employeeId: id,
    scopes,
    allowedPurposes,
    approvalPolicy,
    actionLimits: normalizeActionLimits(body.actionLimits),
    managerId: body.managerId === undefined ? undefined : (body.managerId ? String(body.managerId) : null),
    voice: body.voice === undefined ? undefined : normalizeVoice(body.voice),
    projectAccess:
      body.projectAccess === undefined ? undefined : normalizeProjectAccess(body.projectAccess),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(roleLabel !== undefined ? { roleLabel } : {}),
  });
  if (!updated) return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  const identityUpdated = displayName !== undefined || roleLabel !== undefined;
  const summary = identityUpdated
    ? displayName !== undefined && roleLabel !== undefined
      ? `${updated.displayName} の表示名と職務ラベルを更新`
      : `${updated.displayName} の表示名を更新`
    : `${updated.displayName} の権限を更新`;
  await appendAuditEvent({
    orgId,
    employeeId: id,
    credentialId: updated.credentialId,
    actorEmail: gate.actor.email,
    action: "employee.updated",
    purpose: null,
    summary,
    metadata: { scopes: updated.scopes, approvalPolicy: updated.approvalPolicy, sodLevel: updated.sodLevel, actionLimits: updated.actionLimits },
  });
  return NextResponse.json({ ok: true, employee: updated });
}
