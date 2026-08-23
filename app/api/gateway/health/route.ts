import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getGatewayStatusForOrg, getOrgMeta, runtimeModeLabel } from "@/lib/data";
import { listGatewayToolIds } from "@/lib/gateway/tools";

/** Slim gateway health stub for Managed / BYO Grok Bot link. */
export async function GET() {
  const orgId = await getCurrentOrgId();
  const org = await getOrgMeta(orgId);
  return NextResponse.json({
    ok: true,
    orgId: org.id,
    mode: org.integrationMode,
    status: await getGatewayStatusForOrg(orgId),
    endpoint: "/api/gateway/invoke",
    runtimeMode: runtimeModeLabel(),
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
      runtimeModeLabel() === "demo"
        ? "DEMO mode — Partner API / Cursor Grok Bot handshake is stubbed. Keys optional."
        : "Production org gateway health (partner handshake may still be stubbed).",
  });
}
