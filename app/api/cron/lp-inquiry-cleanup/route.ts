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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifyCronSecret(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || cronSecret.startsWith("replace_me")) {
    console.warn("[lp-inquiry-cleanup] CRON_SECRET not configured");
    return false;
  }
  
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return false;
  }
  
  const token = authHeader.replace("Bearer ", "");
  return token === cronSecret;
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
