import { NextResponse } from "next/server";
import { getGatewayStatus, setGatewayStatus } from "@/lib/demo-data";
import type { GatewayLinkStatus, IntegrationMode } from "@/lib/types";

export async function GET() {
  return NextResponse.json({
    status: getGatewayStatus(),
    machine: ["disconnected", "pending", "linked"],
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: "connect" | "disconnect" | "handshake";
    mode?: IntegrationMode;
  };
  const action = body.action || "connect";
  let next: GatewayLinkStatus = getGatewayStatus();
  if (action === "disconnect") next = "disconnected";
  else if (action === "connect") next = "pending";
  else if (action === "handshake") next = "linked";
  setGatewayStatus(next);
  return NextResponse.json({
    ok: true,
    status: next,
    mode: body.mode || "managed",
    demo: true,
    message:
      next === "linked"
        ? "Grok Bot へ連携完了（デモ）"
        : next === "pending"
          ? "Grok Botへ連携→戻る を待機中"
          : "連携解除済み",
  });
}
