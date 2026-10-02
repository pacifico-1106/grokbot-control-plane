/** Daily spam sweep job (used by app/api/cron/spam-sweep). */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isSignupAttemptLogEnabled, isSpamAdminToolsEnabled, isSpamSweepEnabled } from "@/lib/feature-flags";
import { createSupabaseSpamStore, type SpamStore } from "@/lib/spam/store";
import { runSpamScan, SPAM_SCAN_DEFAULT_DAYS } from "@/lib/spam/scan";
import { proposeSuspendTicket, type ProposeDeps } from "@/lib/spam/propose";
import { createSupabaseAdminClient } from "@/lib/supabase";

function bearerMatches(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header || "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export type SpamSweepDeps = {
  store?: SpamStore | null;
  propose?: Partial<ProposeDeps>;
  purge?: () => Promise<number | null>;
  now?: Date;
};

async function defaultPurge(): Promise<number | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.rpc("purge_signup_attempts", { p_days: 90 });
  if (error) return null;
  return typeof data === "number" ? data : null;
}

/**
 * Daily spam sweep (SPAM_SWEEP_ENABLED, default OFF).
 * scan (read-only) → store masked report → at most ONE pending suspend
 * proposal ticket in PLATFORM_OPS_ORG_ID. Never suspends/deletes by itself.
 */
export async function runSpamSweep(req: Request, deps: SpamSweepDeps = {}) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) return NextResponse.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isSpamSweepEnabled()) return NextResponse.json({ ok: true, skipped: "flag_off" });

  const store = deps.store === undefined ? createSupabaseSpamStore() : deps.store;
  if (!store) return NextResponse.json({ ok: false, error: "store_not_configured" }, { status: 503 });
  const now = deps.now ?? new Date();
  try {
    const report = await runSpamScan(store, SPAM_SCAN_DEFAULT_DAYS, now);
    const reportId = await store.insertReport({
      trigger: "cron",
      windowDays: report.windowDays,
      candidateCount: report.candidateCount,
      watchCount: report.watchCount,
      report,
    });
    let proposal: Awaited<ReturnType<typeof proposeSuspendTicket>> | { proposed: false; reason: string } = {
      proposed: false,
      reason: "spam_admin_tools_disabled",
    };
    // Proposals are only useful if the approve → fulfill path is enabled.
    if (isSpamAdminToolsEnabled()) {
      proposal = await proposeSuspendTicket(store, report, (process.env.PLATFORM_OPS_ORG_ID || "").trim() || null, deps.propose, now);
      if (proposal.proposed && reportId) await store.setReportProposal(reportId, proposal.approvalId);
    }
    const purged = isSignupAttemptLogEnabled() ? await (deps.purge ?? defaultPurge)() : null;
    return NextResponse.json({
      ok: true,
      reportId,
      scanned: report.scanned,
      candidateCount: report.candidateCount,
      watchCount: report.watchCount,
      proposableCount: report.proposableOrgIds.length,
      proposal,
      purgedSignupAttempts: purged,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "unknown_error" }, { status: 500 });
  }
}
