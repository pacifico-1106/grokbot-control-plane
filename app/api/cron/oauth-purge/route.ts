import { NextResponse } from "next/server";
import { getOAuthStore } from "@/lib/data/oauth";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { DCR_STALE_CLIENT_AFTER_SEC } from "@/lib/mcp-oauth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily purge of expired OAuth artifacts (auth requests, codes, access/refresh tokens).
 * CRON_SECRET required. While MCP_OAUTH_ENABLED is OFF it does nothing (tables may not exist yet).
 * Grants are kept (audit trail); revoked/expired grants stop working via the RS checks.
 * #318 follow-up: also deletes DCR clients unused for DCR_STALE_CLIENT_AFTER_SEC
 * (last_used_at, else created_at) that have NO grant at all — i.e. registrations
 * nobody ever consented to. A consented client (any grant) is never deleted.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) return NextResponse.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isMcpOAuthEnabled()) return NextResponse.json({ ok: true, skipped: "oauth_disabled" });
  try {
    const store = getOAuthStore();
    const now = Date.now();
    const purged = await store.purgeExpired(new Date(now).toISOString());
    const staleDcrClients = await store.deleteStaleDcrClients(new Date(now - DCR_STALE_CLIENT_AFTER_SEC * 1000).toISOString());
    return NextResponse.json({ ok: true, purged, staleDcrClients });
  } catch {
    return NextResponse.json({ ok: false, error: "purge_failed" }, { status: 500 });
  }
}
