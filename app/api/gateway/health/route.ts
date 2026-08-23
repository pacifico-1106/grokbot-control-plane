import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getGatewayStatusForOrg, getOrgMeta, runtimeModeLabel } from "@/lib/data";

/** Slim gateway health stub for Managed / BYO Grok Bot link. */
export async function GET() {
  const orgId = await getCurrentOrgId();
  const org = await getOrgMeta(orgId);
  return NextResponse.json({
    ok: true,
    orgId: org.id,
    mode: org.integrationMode,
    status: await getGatewayStatusForOrg(orgId),
    endpoint: "/v1/gateway",
    runtimeMode: runtimeModeLabel(),
    scopesHint: [
      "tools:read",
      "tools:invoke",
      "mail:draft",
      "mail:send",
      "approvals:request",
      "audit:append",
    ],
    note:
      runtimeModeLabel() === "demo"
        ? "DEMO mode — Partner API / Cursor Grok Bot handshake is stubbed."
        : "Production org gateway health (partner handshake may still be stubbed).",
  });
}
