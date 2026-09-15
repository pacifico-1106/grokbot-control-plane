import { NextResponse } from "next/server";
import { processW1MentionWatchAllOrgs } from "@/lib/stuck-watch/w1-mention-unanswered";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron: W1 mention-unanswered watch — notify via policy.notifyMouth.
 * Does not auto-retry expected_gate (notification only).
 */
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

  try {
    const results = await processW1MentionWatchAllOrgs();
    const notified = results.filter((row) => row.ok && !row.skipped);

    return NextResponse.json({
      ok: true,
      scanned: results.length,
      notified: notified.length,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
