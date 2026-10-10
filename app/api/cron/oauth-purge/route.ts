import { NextResponse } from "next/server";
import { getOAuthStore } from "@/lib/data/oauth";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily purge of expired OAuth artifacts (auth requests, codes, access/refresh tokens).
 * CRON_SECRET required. While MCP_OAUTH_ENABLED is OFF it does nothing (tables may not exist yet).
 * Grants are kept (audit trail); revoked/expired grants stop working via the RS checks.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) return NextResponse.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isMcpOAuthEnabled()) return NextResponse.json({ ok: true, skipped: "oauth_disabled" });
  try {
    const purged = await getOAuthStore().purgeExpired(new Date().toISOString());
    return NextResponse.json({ ok: true, purged });
  } catch {
    return NextResponse.json({ ok: false, error: "purge_failed" }, { status: 500 });
  }
}
