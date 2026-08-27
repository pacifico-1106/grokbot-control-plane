import { NextResponse } from "next/server";
import { dispatchAuthorityEventOutbox } from "@/lib/commerce/authority-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) {
    return NextResponse.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await dispatchAuthorityEventOutbox();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("cross-product authority dispatcher failed", error);
    return NextResponse.json(
      { ok: false, error: "authority_dispatch_failed" },
      { status: 500 },
    );
  }
}
