import { assertWebActorApproverAuthority, webDirectDeniedBody } from "@/lib/approver-authority/web-direct";
import { getCurrentOrgId } from "@/lib/auth/session";
import { requireCredentialAdmin } from "@/lib/auth/require-credential-admin";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { revokeAllEmployeeGrants } from "@/lib/mcp-oauth/grant-admin";
import {
  appendAuditEvent,
  bindingPublicView,
  getEmployee,
  rotateCredential,
  runtimeModeLabel,
} from "@/lib/data";
import { mintOneTimeSecret } from "@/lib/bindings";
import { isAdminMcpCredentialReissueEnabled } from "@/lib/feature-flags";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";

/**
 * Reissue credential secret: generation++ only.
 * employeeId and agent link are preserved (never silently cleared).
 *
 * Authority = issuing: owner/admin + hire_issue_credentials (fail-closed).
 * Every successful rotation writes a `credential.rotated` audit row that
 * carries only a 12-char hash prefix — never the secret or the full hash.
 *
 * reissueApprovalId (ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED, default OFF): the
 * hand-over of an approved admin MCP employees.credential.reissue ticket. Same
 * gate as above; the ticket must be this org's / this employee's, approved,
 * unused and inside its 24h window (lib/employees/credential-reissue). The new
 * secret is shown once to this human only, exactly like a plain rotate.
 */
const REISSUE_STATUS: Record<string, number> = {
  feature_disabled: 400,
  reissue_approval_not_found: 404,
  reissue_approval_mismatch: 409,
  reissue_approval_not_approved: 409,
  reissue_approval_used: 409,
  reissue_approval_expired: 410,
  employee_terminated: 409,
  revoked: 403,
};
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
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
  const { id } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) {
    return jsonUtf8({ error: "employee_not_found" }, { status: 404 });
  }
  // Review 2026-10-09 item 2: a new credential carries the employee's permissions.
  const authority = await assertWebActorApproverAuthority({
    orgId,
    memberId: gate.actor.id,
    actorEmail: gate.actor.email,
    changes: [{ tool: "web.employeeRotate", adminMutation: {}, kind: "owner_or_designated_admin" }],
    surface: "employees.rotate",
  });
  if (!authority.ok) return jsonUtf8(webDirectDeniedBody(authority), { status: 403 });

  const targetOrgId = employee.orgId || orgId;
  const reissueApprovalId =
    typeof rawBody.reissueApprovalId === "string" ? rawBody.reissueApprovalId.trim() : "";
  if (reissueApprovalId) {
    if (!isAdminMcpCredentialReissueEnabled()) {
      return jsonUtf8({ error: "feature_disabled" }, { status: 400 });
    }
    const { redeemCredentialReissue } = await import("@/lib/employees/credential-reissue");
    const r = await redeemCredentialReissue({
      orgId: targetOrgId,
      employeeId: id,
      approvalId: reissueApprovalId,
      actor: { memberId: gate.actor.id, email: gate.actor.email ?? null },
    });
    if (!r.ok) {
      return jsonUtf8({ error: r.code, message: r.messageJa }, { status: REISSUE_STATUS[r.code] ?? 500 });
    }
    return jsonUtf8({
      ok: true,
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
      employeeId: id,
      reissueApprovalId,
      generation: r.generation,
      binding: bindingPublicView(r.binding),
      credential: {
        prefix: r.secret.prefix,
        oneTimeSecret: r.secret.raw,
        fingerprint: r.secret.fingerprint.slice(0, 12) + "…",
        notice:
          "承認済みの依頼で社員証を再発行しました。古い社員証は失効しました。秘密値は一度だけ表示されます（AI やチャットには貼らないでください）。",
      },
      message: `credentialGeneration=${r.generation}（ID不変）`,
    });
  }

  try {
    const secret = mintOneTimeSecret();
    const { binding, generation } = await rotateCredential(
      id,
      targetOrgId,
      secret.fingerprint,
      {
        secretPrefix: secret.prefix,
        scopes: employee.scopes,
        allowedPurposes: employee.allowedPurposes,
        approvalPolicy: employee.approvalPolicy,
        actionLimits: employee.actionLimits,
        spend: employee.spend,
        allowedAccounts: employee.allowedAccounts,
      }
    );
    await appendAuditEvent({
      orgId: targetOrgId,
      employeeId: id,
      credentialId: employee.credentialId ?? null,
      actorEmail: gate.actor.email,
      action: "credential.rotated",
      purpose: null,
      summary: `${employee.displayName} の社員証を再発行（世代 ${generation}）`,
      metadata: {
        generation,
        secretHashPrefix: secret.fingerprint.slice(0, 12),
        actorMemberId: gate.actor.id,
      },
    });
    // Q3: rotation does NOT cut OAuth connections unless explicitly requested.
    let oauthGrantsRevoked: number | undefined;
    let oauthRevokeFailed = false;
    if (rawBody.revokeOAuth === true && isMcpOAuthEnabled()) {
      try {
        oauthGrantsRevoked = await revokeAllEmployeeGrants({
          orgId: targetOrgId,
          employeeId: id,
          byEmail: gate.actor.email,
          reason: "rotate",
        });
      } catch {
        oauthRevokeFailed = true; // rotation itself succeeded; surface so the admin can retry from the list
      }
    }
    return jsonUtf8({
      ok: true,
      ...(oauthGrantsRevoked !== undefined ? { oauthGrantsRevoked } : {}),
      ...(oauthRevokeFailed ? { oauthRevokeFailed } : {}),
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
      employeeId: id,
      generation,
      binding: bindingPublicView(binding),
      credential: {
        prefix: secret.prefix,
        oneTimeSecret: secret.raw,
        fingerprint: secret.fingerprint.slice(0, 12) + "…",
        notice:
          "社員証を再発行しました。employeeId は変わりません。秘密値は一度だけ表示されます。",
      },
      message: `credentialGeneration=${generation}（ID不変）`,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "revoked") {
      return jsonUtf8(
        { error: "revoked", message: "取り消された連携の再発行は拒否" },
        { status: 403 }
      );
    }
    return jsonUtf8({ error: "rotate_failed" }, { status: 500 });
  }
}
