import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cron-secret";
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import { listOrgIdsWithEnabledSlackAdapter } from "@/lib/data/conversation-adapters";
import { backfillOrgChannelProposals } from "@/lib/channel-classify/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron (PR-B): classification proposals for Slack channels each org's own bot
 * already joined. CHANNEL_CLASSIFY_PROPOSALS_ENABLED OFF → no-op. Each org is
 * processed with its own bot token only; results are ids and counts.
 * Not scheduled in vercel.json yet (call manually / add a schedule when enabled).
 */
export async function GET(req: Request) {
  const rejected = rejectUnauthorizedCron(req);
  if (rejected) return rejected;
  if (!isChannelClassifyProposalsEnabled()) {
    return NextResponse.json({ ok: true, skipped: true, reason: "CHANNEL_CLASSIFY_PROPOSALS_ENABLED is OFF" });
  }
  try {
    const orgIds = await listOrgIdsWithEnabledSlackAdapter();
    let created = 0;
    let failedOrgs = 0;
    for (const orgId of orgIds) {
      const result = await backfillOrgChannelProposals(orgId).catch(() => null);
      if (!result || !result.ok) failedOrgs += 1;
      created += result?.created ?? 0;
    }
    return NextResponse.json({ ok: true, orgs: orgIds.length, created, failedOrgs });
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80) : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
