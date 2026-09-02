import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { adminAgentPublicView, setOrgAdminOpsDocLocation } from "@/lib/data/admin-agents";
import { parseRolesProposeInput } from "@/lib/mcp/roles-propose";

export const runtime = "nodejs";

/** Collect PROCESS SOURCE. Drive is optional. At least one content field. */
export async function POST(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseRolesProposeInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: parsed.code,
        message: parsed.message,
        driveRequired: false,
      },
      { status: 400 }
    );
  }
  const stored =
    parsed.value.location ||
    (parsed.value.transcript
      ? `voice:${parsed.value.transcript.slice(0, 240)}`
      : `text:${parsed.value.text.slice(0, 240)}`);
  const agent = await setOrgAdminOpsDocLocation({
    orgId: gate.orgId,
    opsDocLocation: stored,
  });
  return NextResponse.json({
    ok: true,
    agent: adminAgentPublicView(agent),
    sourceType: parsed.value.sourceType,
    driveWired: false,
    driveRequired: false,
    noticeJa: "正本を控えました。Drive がなくても進めます。人確認は承認へ。",
  });
}
