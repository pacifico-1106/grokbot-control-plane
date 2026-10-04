/**
 * MCP Events delivery retries.
 *
 * GET|POST /api/cron/mcp-events-deliver — attempts pending deliveries whose
 * backoff has elapsed (first attempt happens inline at emit time).
 * Requires CRON_SECRET (Authorization: Bearer … or x-cron-secret).
 * Feature flag: MCP_EVENTS_ENABLED (default OFF → no-op).
 * Not in vercel.json yet: adding the schedule is a production step
 * (docs/mcp-events-approval-wake-20261005.md).
 */
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isMcpEventsEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateCronSecret(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return safeEqual(request.headers.get("authorization"), `Bearer ${cronSecret}`) ||
    safeEqual(request.headers.get("x-cron-secret"), cronSecret);
}

export async function POST(request: NextRequest) {
  if (!validateCronSecret(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isMcpEventsEnabled()) return NextResponse.json({ status: "skipped", reason: "feature_disabled" });
  try {
    const { deliverDueEvents } = await import("@/lib/mcp-events/service");
    const result = await deliverDueEvents({ limit: 100 });
    return NextResponse.json({ status: "completed", ...result });
  } catch {
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
