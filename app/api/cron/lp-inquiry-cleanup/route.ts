/**
 * Cron endpoint for cleaning up expired LP inquiries.
 * Feature flag LP_INQUIRY_CLEANUP_ENABLED must be ON.
 * 
 * This should be called by Vercel Cron or external scheduler.
 * Protected by CRON_SECRET header.
 */

import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isLpInquiryCleanupEnabled } from "@/lib/feature-flags";
import { checkCronRequest, readCronSecret } from "@/lib/security/cron-secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CRON_SECRET check through the shared constant-time helper. Accepts
 * `Authorization: Bearer <CRON_SECRET>` or the raw `<CRON_SECRET>` (the caller
 * is unknown, so the raw form stays). CRON_SECRET is not trimmed, as before.
 * Unset / placeholder secrets keep answering 401 here (not the 503 the
 * non-LP crons use).
 */
function verifyCronSecret(req: Request): boolean {
  const decision = checkCronRequest(req, { allowRawSecret: true, trimSecret: false });
  if (decision !== "ok" && readCronSecret({ trim: false }).state !== "set") {
    console.warn("[lp-inquiry-cleanup] CRON_SECRET not configured");
  }
  return decision === "ok";
}

export async function GET(req: Request) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401 }
    );
  }

  if (!isLpInquiryCleanupEnabled()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "feature_flag_off",
      message: "LP_INQUIRY_CLEANUP_ENABLED is OFF",
    });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "db_not_configured" },
      { status: 500 }
    );
  }

  try {
    const { data, error } = await admin.rpc("cleanup_expired_lp_inquiries");

    if (error) {
      console.error("[lp-inquiry-cleanup] Cleanup failed:", error);
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    const deletedCount = Number(data) || 0;
    console.info("[lp-inquiry-cleanup] Cleanup completed:", { deletedCount });

    return NextResponse.json({
      ok: true,
      deletedCount,
    });
  } catch (error) {
    console.error("[lp-inquiry-cleanup] Cleanup error:", error);
    return NextResponse.json(
      { ok: false, error: "cleanup_failed" },
      { status: 500 }
    );
  }
}
