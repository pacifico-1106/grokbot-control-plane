import { NextResponse } from "next/server";
import { isDemoMode, isResendConfigured, isStripeConfigured, runtimeModeLabel } from "@/lib/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public cutover probe — no auth.
 * Expect runtimeMode:"production" after real Supabase URL+anon+service_role are set.
 */
export async function GET() {
  const runtimeMode = runtimeModeLabel();
  return NextResponse.json({
    ok: true,
    runtimeMode,
    demo: isDemoMode(),
    supabaseConfigured: !isDemoMode(),
    stripeConfigured: isStripeConfigured(),
    resendConfigured: isResendConfigured(),
  });
}
