import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cron-secret";
import { sendTenantDigests } from "@/lib/notify/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rejected = rejectUnauthorizedCron(req);
  if (rejected) return rejected;

  const results = await sendTenantDigests();
  return NextResponse.json({
    ok: results.every((result) => result.ok || result.skipped),
    deliveries: results.length,
    failed: results.filter((result) => !result.ok && !result.skipped).length,
  });
}
