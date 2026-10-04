/**
 * MCP Events delivery retries + retention.
 *
 * GET|POST /api/cron/mcp-events-deliver — attempts pending deliveries whose
 * backoff (or deferral) has elapsed (the first attempt happens inline at emit
 * time), then deletes finished delivery rows older than the retention
 * (MCP_EVENTS_LIMITS.deliveryRetentionMs = 7 days).
 * Auth: shared helper lib/security/cron-secret.ts (PR #264) — exactly
 * `Authorization: Bearer <CRON_SECRET>`; unset → 503, wrong / placeholder → 401.
 * Feature flag: MCP_EVENTS_ENABLED (default OFF → no-op, nothing pruned).
 * Not in vercel.json yet: adding the schedule is a production step
 * (docs/mcp-events-approval-wake-20261005.md).
 */
import { NextResponse } from "next/server";
import { isMcpEventsEnabled } from "@/lib/feature-flags";
import { rejectUnauthorizedCron } from "@/lib/security/cron-secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = rejectUnauthorizedCron(req);
  if (denied) return denied;
  if (!isMcpEventsEnabled()) return NextResponse.json({ status: "skipped", reason: "feature_disabled" });
  try {
    const { deliverDueEvents, pruneFinishedDeliveries } = await import("@/lib/mcp-events/service");
    const result = await deliverDueEvents({ limit: 100 });
    const pruned = await pruneFinishedDeliveries({ limit: 500 });
    return NextResponse.json({ status: "completed", ...result, pruned: pruned.deleted });
  } catch {
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
