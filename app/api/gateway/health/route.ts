import { NextResponse } from "next/server";
import { DEMO_ORG, getGatewayStatus } from "@/lib/demo-data";

/** Slim gateway health stub for Managed / BYO Grok Bot link. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    orgId: DEMO_ORG.id,
    mode: DEMO_ORG.integrationMode,
    status: getGatewayStatus(),
    endpoint: "/v1/gateway",
    scopesHint: [
      "tools:read",
      "tools:invoke",
      "mail:draft",
      "mail:send",
      "approvals:request",
      "audit:append",
    ],
    note: "Partner API / Cursor Grok Bot handshake is not yet available — status is demo.",
  });
}
