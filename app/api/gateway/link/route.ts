import { NextResponse } from "next/server";
import { requireOrgSession } from "@/lib/auth/require-org";
import {
  getGatewayStatusForOrg,
  runtimeModeLabel,
  setGatewayStatusForOrg,
} from "@/lib/data";
import type { GatewayLinkStatus, IntegrationMode } from "@/lib/types";

export async function GET() {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;
  return NextResponse.json({
    status: await getGatewayStatusForOrg(gate.orgId),
    machine: ["disconnected", "pending", "linked"],
    mode: runtimeModeLabel(),
  });
}

export async function POST(req: Request) {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as {
    action?: "connect" | "disconnect" | "handshake";
    mode?: IntegrationMode;
  };
  const orgId = gate.orgId;
  const action = body.action || "connect";
  let next: GatewayLinkStatus = await getGatewayStatusForOrg(orgId);
  if (action === "disconnect") next = "disconnected";
  else if (action === "connect") next = "pending";
  else if (action === "handshake") next = "linked";
  await setGatewayStatusForOrg(next, orgId);
  return NextResponse.json({
    ok: true,
    status: next,
    mode: body.mode || "managed",
    demo: runtimeModeLabel() === "demo",
    runtimeMode: runtimeModeLabel(),
    message:
      next === "linked"
        ? "Grok Bot へ連携完了（デモ）"
        : next === "pending"
          ? "Grok Botへ連携→戻る を待機中"
          : "連携解除済み",
  });
}
