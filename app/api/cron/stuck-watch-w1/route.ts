import { NextResponse } from "next/server";
import { processW1MentionWatchAllOrgs } from "@/lib/stuck-watch/w1-mention-unanswered";
import { listPendingT2Decisions } from "@/lib/data/approvals";
import { checkAndExpireT2Decision } from "@/lib/decision-workflow/expiry";
import { isDecisionWorkflowEnabled, isMcpEndpointHandoffEnabled } from "@/lib/feature-flags";
import { processMcpNotConnectedWatchAllOrgs } from "@/lib/mcp/endpoint-handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron: W1 mention-unanswered watch — notify via policy.notifyMouth.
 * Also processes T2 decision expiry (hourly check, runs every 5min but idempotent).
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

    const t2Expiry = { candidates: 0, rejected: 0, skipped: 0, errors: 0 };

    if (isDecisionWorkflowEnabled()) {
      const now = new Date();
      const t2Decisions = await listPendingT2Decisions();

      for (const approval of t2Decisions) {
        const result = await checkAndExpireT2Decision(approval, now);
        t2Expiry.candidates++;
        if (result.action === "rejected") t2Expiry.rejected++;
        else if (result.action === "skipped") t2Expiry.skipped++;
        else if (result.action === "error") t2Expiry.errors++;
      }
    }

    // MCP endpoint handoff: woken-but-never-connected → one next-step notice
    // per employee per 24h to a human channel (no re-wake). Flag OFF → skipped.
    const mcpHandoff = isMcpEndpointHandoffEnabled()
      ? await processMcpNotConnectedWatchAllOrgs().catch(() => [])
      : null;

    return NextResponse.json({
      ok: true,
      scanned: results.length,
      notified: notified.length,
      results,
      t2Expiry,
      ...(mcpHandoff ? { mcpHandoffNotConnected: mcpHandoff } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
