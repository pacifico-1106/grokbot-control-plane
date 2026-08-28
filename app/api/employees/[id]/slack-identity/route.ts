import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { appendAuditEvent, getEmployee, updateEmployeePolicy } from "@/lib/data";
import {
  getEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import { slackOAuthConfigured } from "@/lib/slack/oauth";
import { requireCapability } from "@/lib/team/demo-actor";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await getCurrentOrgId();
  if (!orgId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  const { id } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  const identity = await getEmployeeSlackIdentity(id);
  return NextResponse.json({
    ok: true,
    postingAs: employee.postingAs || "bot",
    identity,
    oauthConfigured: slackOAuthConfigured(),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireCapability(
    req,
    "hire_issue_credentials",
    typeof body.actorMemberId === "string" ? body.actorMemberId : null
  );
  if (!gate.ok) return gate.response;
  const orgId = await getCurrentOrgId();
  if (!orgId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  const { id } = await ctx.params;
  const existing = await getEmployee(id, orgId);
  if (!existing) return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  if (existing.status === "suspended") {
    return NextResponse.json({ error: "employee_terminated" }, { status: 403 });
  }
  const postingAs = normalizePostingAs(body.postingAs);
  const updated = await updateEmployeePolicy({
    orgId,
    employeeId: id,
    scopes: existing.scopes,
    allowedPurposes: existing.allowedPurposes,
    approvalPolicy: existing.approvalPolicy,
    actionLimits: existing.actionLimits,
    postingAs,
  });
  if (!updated) return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  await appendAuditEvent({
    orgId,
    employeeId: id,
    credentialId: updated.credentialId,
    actorEmail: gate.actor.email,
    action: "employee.updated",
    purpose: null,
    summary: `${updated.displayName} の Slack 投稿名義を更新`,
    metadata: { postingAs },
  });
  const identity = await getEmployeeSlackIdentity(id);
  return NextResponse.json({
    ok: true,
    employee: updated,
    identity,
    oauthConfigured: slackOAuthConfigured(),
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireCapability(
    req,
    "hire_issue_credentials",
    typeof body.actorMemberId === "string" ? body.actorMemberId : null
  );
  if (!gate.ok) return gate.response;
  const orgId = await getCurrentOrgId();
  if (!orgId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  const { id } = await ctx.params;
  const existing = await getEmployee(id, orgId);
  if (!existing) return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  await revokeEmployeeSlackIdentity({ employeeId: id, orgId });
  await appendAuditEvent({
    orgId,
    employeeId: id,
    credentialId: existing.credentialId,
    actorEmail: gate.actor.email,
    action: "employee.updated",
    purpose: null,
    summary: `${existing.displayName} の Slack 本人連携を解除`,
    metadata: { slackIdentity: "revoked" },
  });
  return NextResponse.json({ ok: true, identity: null });
}
