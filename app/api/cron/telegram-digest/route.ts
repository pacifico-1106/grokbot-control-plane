import { NextResponse } from "next/server";
import { sendTenantDigests } from "@/lib/notify/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "cron_not_configured" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const results = await sendTenantDigests();
  return NextResponse.json({
    ok: results.every((result) => result.ok || result.skipped),
    deliveries: results.length,
    failed: results.filter((result) => !result.ok && !result.skipped).length,
  });
}
