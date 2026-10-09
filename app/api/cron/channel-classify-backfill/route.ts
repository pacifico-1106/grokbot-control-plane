import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cron-secret";
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import { listOrgIdsWithEnabledSlackAdapter } from "@/lib/data/conversation-adapters";
import { BACKFILL_TIME_BUDGET_MS, backfillNow, backfillOrgChannelProposals } from "@/lib/channel-classify/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Cron (PR-B): classification proposals for Slack channels each org's own bot
 * already joined. CHANNEL_CLASSIFY_PROPOSALS_ENABLED OFF → no-op. Each org is
 * processed with its own bot token only; results are ids and counts.
 * Not scheduled in vercel.json yet (call manually / add a schedule when enabled).
 * Follow-up N4: one run-wide time budget for all orgs (orgs in random order so
 * no org is always last); Slack ratelimited stops that org only.
 */
export async function GET(req: Request) {
  const rejected = rejectUnauthorizedCron(req);
  if (rejected) return rejected;
  if (!isChannelClassifyProposalsEnabled()) {
    return NextResponse.json({ ok: true, skipped: true, reason: "CHANNEL_CLASSIFY_PROPOSALS_ENABLED is OFF" });
  }
  try {
    const orgIds = shuffle(await listOrgIdsWithEnabledSlackAdapter());
    const deadlineMs = backfillNow() + BACKFILL_TIME_BUDGET_MS;
    let created = 0;
    let failedOrgs = 0;
    let rateLimitedOrgs = 0;
    let deferredOrgs = 0;
    for (const orgId of orgIds) {
      if (backfillNow() >= deadlineMs) {
        deferredOrgs += 1;
        continue;
      }
      const result = await backfillOrgChannelProposals(orgId, { deadlineMs }).catch(() => null);
      if (!result || !result.ok) failedOrgs += 1;
      if (result?.stoppedReason === "rate_limited") rateLimitedOrgs += 1;
      if (result?.stoppedReason === "time_budget") deferredOrgs += 1;
      created += result?.created ?? 0;
    }
    return NextResponse.json({ ok: true, orgs: orgIds.length, created, failedOrgs, rateLimitedOrgs, deferredOrgs });
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80) : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
