import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cron-secret";
import { listPendingT2Decisions } from "@/lib/data/approvals";
import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";
import { checkAndExpireT2Decision } from "@/lib/decision-workflow/expiry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * T2 Decision Expiry — auto-reject expired T2 decisions.
 * Called from stuck-watch-w1 cron (not registered as separate cron).
 *
 * Security:
 * - fail_closed: Never approve on error, always reject
 * - Only processes T2 decisions (T1/T3 don't auto-expire)
 * - Idempotent: Already resolved decisions are skipped
 * - Only active when P1_DECISION_WORKFLOW_ENABLED is ON
 */
export async function GET(req: Request) {
  const rejected = rejectUnauthorizedCron(req);
  if (rejected) return rejected;

  if (!isDecisionWorkflowEnabled()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "P1_DECISION_WORKFLOW_ENABLED is OFF",
    });
  }

  try {
    const now = new Date();
    const t2Decisions = await listPendingT2Decisions();

    let rejected = 0;
    let skipped = 0;
    let errors = 0;

    for (const approval of t2Decisions) {
      const result = await checkAndExpireT2Decision(approval, now);
      if (result.action === "rejected") rejected++;
      else if (result.action === "skipped") skipped++;
      else if (result.action === "error") errors++;
    }

    return NextResponse.json({
      ok: true,
      candidates: t2Decisions.length,
      rejected,
      skipped,
      errors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
