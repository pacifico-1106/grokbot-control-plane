import { NextResponse } from "next/server";
import { listApprovalsForTelegramDigest } from "@/lib/data/approvals";
import {
  isApprovedUnfulfilled,
  processW2RetriesForApprovals,
} from "@/lib/stuck-watch/w2-unfulfilled";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron: W2 approved-but-unfulfilled watch — auto reinvoke fulfill (max 2).
 * Integrates with existing fulfill paths (#53 family); does not duplicate them.
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
    const approvals = await listApprovalsForTelegramDigest();
    const candidates = approvals.filter(isApprovedUnfulfilled);
    const results = await processW2RetriesForApprovals(candidates);

    return NextResponse.json({
      ok: true,
      scanned: approvals.length,
      candidates: candidates.length,
      retried: results.length,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
