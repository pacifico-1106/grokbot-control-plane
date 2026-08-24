import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getGatewayStatusForOrg, getOrgMeta, runtimeModeLabel } from "@/lib/data";
import { listGatewayToolIds } from "@/lib/gateway/tools";
import { isDemoMode } from "@/lib/mode";

/** Slim gateway health stub for Managed / BYO Grok Bot link. */
export async function GET() {
  const runtimeMode = runtimeModeLabel();
  const orgId = await getCurrentOrgId();

  // Unauthenticated production probe: still expose runtimeMode (cutover check).
  if (!isDemoMode() && !orgId) {
    return NextResponse.json({
      ok: true,
      runtimeMode,
      demo: false,
      orgId: null,
      status: null,
      endpoint: "/api/gateway/invoke",
      note: "Logged out — runtimeMode only. Sign in for org gateway status.",
    });
  }

  try {
    const org = await getOrgMeta(orgId);
    return NextResponse.json({
      ok: true,
      orgId: org.id,
      mode: org.integrationMode,
      status: await getGatewayStatusForOrg(orgId),
      endpoint: "/api/gateway/invoke",
      runtimeMode,
      demo: runtimeMode === "demo",
      scopesHint: [
        "tools:read",
        "tools:invoke",
        "mail:draft",
        "mail:send",
        "calendar:propose",
        "calendar:confirm",
        "approvals:request",
        "audit:append",
      ],
      toolsAllowlist: listGatewayToolIds(),
      contract: {
        requirePurpose: true,
        requireJobId: true,
        unknownTools: "reject",
        confirmSendDefault: "always_human",
        proposeDraftMayAuto: true,
        agentMail: "p0.5_reserved",
      },
      note:
        runtimeMode === "demo"
          ? "DEMO mode — Partner API / Cursor Grok Bot handshake is stubbed. Keys optional."
          : "Production org gateway health (partner handshake may still be stubbed).",
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        runtimeMode,
        demo: runtimeMode === "demo",
        error: e instanceof Error ? e.message : "gateway_health_failed",
      },
      { status: 500 }
    );
  }
}
