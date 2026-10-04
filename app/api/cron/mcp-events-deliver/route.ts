/**
 * MCP Events delivery retries + retention.
 *
 * GET|POST /api/cron/mcp-events-deliver — attempts pending deliveries whose
 * backoff (or deferral) has elapsed (the first attempt happens inline at emit
 * time), then deletes finished delivery rows older than the retention
 * (MCP_EVENTS_LIMITS.deliveryRetentionMs = 7 days) and verification-budget
 * windows older than 10 minutes (D11).
 * Auth: shared helper lib/security/cron-secret.ts (PR #264) — exactly
 * `Authorization: Bearer <CRON_SECRET>`; unset → 503, wrong / placeholder → 401.
 * Feature flag: MCP_EVENTS_ENABLED (default OFF → "skipped": the service
 * module is never loaded and no Supabase client is created).
 * Schedule: vercel.json, every minute (D6, 八坂 GO 2026-10-05).
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
    const { deliverDueEvents, pruneFinishedDeliveries, pruneVerificationWindows } = await import("@/lib/mcp-events/service");
    const result = await deliverDueEvents({ limit: 100 });
    const pruned = await pruneFinishedDeliveries({ limit: 500 });
    const windows = await pruneVerificationWindows();
    return NextResponse.json({ status: "completed", ...result, pruned: pruned.deleted, prunedVerificationWindows: windows.deleted });
  } catch {
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
