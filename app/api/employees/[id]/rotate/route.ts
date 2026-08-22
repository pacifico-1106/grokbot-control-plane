import { NextResponse } from "next/server";
import {
  bindingPublicView,
  mintOneTimeSecret,
  rotateCredential,
} from "@/lib/bindings";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";

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
  const employee = getRuntimeEmployees().find((e) => e.id === id);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  try {
    const secret = mintOneTimeSecret();
    const { binding, generation } = rotateCredential(
      id,
      employee.orgId || DEMO_ORG.id,
      secret.fingerprint
    );
    return NextResponse.json({
      ok: true,
      demo: true,
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
