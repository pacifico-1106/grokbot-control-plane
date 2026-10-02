import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { requireCredentialAdmin } from "@/lib/auth/require-credential-admin";
import {
  appendAuditEvent,
  bindingPublicView,
  getEmployee,
  rotateCredential,
  runtimeModeLabel,
} from "@/lib/data";
import { mintOneTimeSecret } from "@/lib/bindings";

export const runtime = "nodejs";

/**
 * Reissue credential secret: generation++ only.
 * employeeId and agent link are preserved (never silently cleared).
 *
 * Authority = issuing: owner/admin + hire_issue_credentials (fail-closed).
 * Every successful rotation writes a `credential.rotated` audit row that
 * carries only a 12-char hash prefix — never the secret or the full hash.
 */
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
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  try {
    const secret = mintOneTimeSecret();
    const targetOrgId = employee.orgId || orgId;
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
    return NextResponse.json({
      ok: true,
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
      return NextResponse.json(
        { error: "revoked", message: "取り消された連携の再発行は拒否" },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: "rotate_failed" }, { status: 500 });
  }
}
