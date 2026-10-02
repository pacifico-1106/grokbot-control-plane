import { NextResponse } from "next/server";
import { isChannelScopeEnabled } from "@/lib/feature-flags";
import { runChannelScopeReconcileCron } from "@/lib/channel-scope/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60 s is allowed on every Vercel plan; the reconcile stops at a 45 s budget and rotates orgs per run.
export const maxDuration = 60;

/**
 * Cron (every 6 h): P1 Channel Scope reconcile (CS5) — users.conversations vs memberships /
 * org_channels for employees whose effective scope is all_joined. Fills missed join events,
 * makes later-shared channels stricter, records leaves / bot removal.
 *
 * P1_CHANNEL_SCOPE_ENABLED OFF ⇒ 200 { skipped: "flag_off" } with no DB / Slack access.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) {
    return NextResponse.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isChannelScopeEnabled()) {
    return NextResponse.json({ ok: true, skipped: "flag_off" });
  }
  try {
    const result = await runChannelScopeReconcileCron();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
