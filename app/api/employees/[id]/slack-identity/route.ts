import { removeAutoDmRoutesForEmployee } from "@/lib/slack/dm-autoroute";
import { getCurrentOrgId } from "@/lib/auth/session";
import { appendAuditEvent, getEmployee } from "@/lib/data";
import {
  getEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import {
  employeePolicyWriteFailure,
  employeePolicyWriteFailurePayload,
  policyErrorPayload,
} from "@/lib/employees/policy-errors";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import {
  currentPostingAs,
  postingAsChangeMetadata,
  writeEmployeePostingAs,
} from "@/lib/employees/posting-identity";
import { slackOAuthConfigured } from "@/lib/slack/oauth";
import { requireCapability } from "@/lib/team/demo-actor";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await getCurrentOrgId();
  if (!orgId) return jsonUtf8(policyErrorPayload("auth_required"), { status: 401 });
  const { id } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) return jsonUtf8(policyErrorPayload("employee_not_found"), { status: 404 });
  const identity = await getEmployeeSlackIdentity(id);
  return jsonUtf8({
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
  if (!orgId) return jsonUtf8(policyErrorPayload("auth_required"), { status: 401 });
  const { id } = await ctx.params;
  const existing = await getEmployee(id, orgId);
  if (!existing) return jsonUtf8(policyErrorPayload("employee_not_found"), { status: 404 });
  if (existing.status === "suspended") {
    return jsonUtf8(policyErrorPayload("employee_terminated"), { status: 403 });
  }
  const postingAs = normalizePostingAs(body.postingAs);
  const from = currentPostingAs(existing);
  let updated: Awaited<ReturnType<typeof writeEmployeePostingAs>>;
  try {
    // Shared with the admin MCP tool employees.postingIdentity.set.
    updated = await writeEmployeePostingAs({ orgId, employee: existing, postingAs });
  } catch (error) {
    // Fail-closed: a failed write is never reported as saved (no audit row).
    const failure = employeePolicyWriteFailure(error);
    console.error(failure.code, id, error instanceof Error ? error.message : error);
    return jsonUtf8(employeePolicyWriteFailurePayload(failure), { status: 500 });
  }
  if (!updated) return jsonUtf8(policyErrorPayload("employee_not_found"), { status: 404 });
  await appendAuditEvent({
    orgId,
    employeeId: id,
    credentialId: updated.credentialId,
    actorEmail: gate.actor.email,
    action: "employee.updated",
    purpose: null,
    summary: `${updated.displayName} の Slack 投稿名義を更新`,
    metadata: postingAsChangeMetadata(from, postingAs),
  });
  const identity = await getEmployeeSlackIdentity(id);
  return jsonUtf8({
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
  if (!orgId) return jsonUtf8(policyErrorPayload("auth_required"), { status: 401 });
  const { id } = await ctx.params;
  const existing = await getEmployee(id, orgId);
  if (!existing) return jsonUtf8(policyErrorPayload("employee_not_found"), { status: 404 });
  await revokeEmployeeSlackIdentity({ employeeId: id, orgId });
  // SLACK_DM_AUTOROUTE_ENABLED (default OFF): drop routes auto-derived for this employee.
  await removeAutoDmRoutesForEmployee({ orgId, employeeId: id });
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
  return jsonUtf8({ ok: true, identity: null });
}
