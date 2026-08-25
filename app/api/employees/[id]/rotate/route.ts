import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
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
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();
  const employee = await getEmployee(id, orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  try {
    const secret = mintOneTimeSecret();
    const { binding, generation } = await rotateCredential(
      id,
      employee.orgId || orgId || "",
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
