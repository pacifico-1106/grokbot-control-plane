import { NextResponse } from "next/server";
import { listApprovalsForTelegramDigest } from "@/lib/data/approvals";
import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";
import { checkAndExpireT2Decision } from "@/lib/decision-workflow/expiry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron: T2 Decision Expiry — auto-reject expired T2 decisions.
 *
 * Security:
 * - fail_closed: Never approve on error, always reject
 * - Only processes T2 decisions (T1/T3 don't auto-expire)
 * - Idempotent: Already resolved decisions are skipped
 * - Only active when P1_DECISION_WORKFLOW_ENABLED is ON
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

  if (!isDecisionWorkflowEnabled()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "P1_DECISION_WORKFLOW_ENABLED is OFF",
    });
  }

  try {
    const now = new Date();
    const approvals = await listApprovalsForTelegramDigest();

    const t2Decisions = approvals.filter((approval) => {
      const metadata = approval.metadata as Record<string, unknown> | null;
      return (
        metadata?.type === "decision_request" &&
        metadata?.tier === "T2" &&
        approval.status === "pending"
      );
    });

    const results = await Promise.all(
      t2Decisions.map((approval) => checkAndExpireT2Decision(approval, now))
    );

    const rejected = results.filter((r) => r.action === "rejected").length;
    const skipped = results.filter((r) => r.action === "skipped").length;
    const errors = results.filter((r) => r.action === "error").length;

    return NextResponse.json({
      ok: true,
      scanned: approvals.length,
      candidates: t2Decisions.length,
      rejected,
      skipped,
      errors,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
