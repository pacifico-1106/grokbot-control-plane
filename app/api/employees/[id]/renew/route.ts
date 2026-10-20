import { assertWebActorApproverAuthority, webDirectDeniedBody } from "@/lib/approver-authority/web-direct";
import { getCurrentOrgId } from "@/lib/auth/session";
import { requireCredentialAdmin } from "@/lib/auth/require-credential-admin";
import { jsonUtf8 } from "@/lib/http/json-utf8";
import {
  isCredentialAutoRenewEnabled,
  isCredentialAutoRenewOnForOrg,
  proposeCredentialAutoRenewNow,
} from "@/lib/employees/credential-auto-renew";

export const runtime = "nodejs";

/**
 * POST /api/employees/[id]/renew — 今すぐ更新 (CREDENTIAL_AUTO_RENEW_ENABLED).
 * Files an always_human ticket. Does not mint or return a secret / claim_token.
 * Flag OFF / other org → 404 feature_disabled (same as a missing route).
 */
const STATUS: Record<string, number> = {
  feature_disabled: 404,
  employee_not_found: 404,
  already_pending: 409,
  held: 409,
  hold_state_unavailable: 409,
  employee_terminated: 409,
  revoked: 409,
  expired: 409,
  no_live_credential: 409,
  invalid_reason: 400,
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!isCredentialAutoRenewEnabled()) {
    return jsonUtf8({ error: "feature_disabled" }, { status: 404 });
  }
  const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireCredentialAdmin(
    req,
    typeof rawBody.actorMemberId === "string" ? rawBody.actorMemberId : null
  );
  if (!gate.ok) return gate.response;
  const orgId = await getCurrentOrgId();
  if (!orgId) {
    return jsonUtf8({ error: "auth_required" }, { status: 401 });
  }
  if (!isCredentialAutoRenewOnForOrg(orgId)) {
    return jsonUtf8({ error: "feature_disabled" }, { status: 404 });
  }
  const { id } = await ctx.params;
  const employeeId = (id || "").trim();
  if (!employeeId) {
    return jsonUtf8({ error: "employee_not_found" }, { status: 404 });
  }
  const authority = await assertWebActorApproverAuthority({
    orgId,
    memberId: gate.actor.id,
    changes: [{ tool: "employees.credential.auto_renew", adminMutation: { employeeId, reason: "now" } }],
    surface: "employees.renew",
  });
  if (!authority.ok) return jsonUtf8(webDirectDeniedBody(authority), { status: 403 });

  const proposed = await proposeCredentialAutoRenewNow({
    orgId,
    employeeId,
    source: "web",
    actor: { memberId: gate.actor.id, email: gate.actor.email ?? null },
  });
  if (!proposed.ok) {
    return jsonUtf8(
      { error: proposed.code, messageJa: proposed.messageJa },
      { status: STATUS[proposed.code] ?? 400 }
    );
  }
  return jsonUtf8({
    ok: true,
    approvalId: proposed.approvalId,
    nextStepJa: proposed.nextStepJa,
  });
}
