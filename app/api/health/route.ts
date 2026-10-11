import { isDemoMode, isResendConfigured, isStripeConfigured, runtimeModeLabel } from "@/lib/mode";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public cutover probe — no auth.
 * Expect runtimeMode:"production" after real Supabase URL+anon+service_role are set.
 */
export async function GET() {
  const runtimeMode = runtimeModeLabel();
  return jsonUtf8({
    ok: true,
    runtimeMode,
    demo: isDemoMode(),
    supabaseConfigured: !isDemoMode(),
    stripeConfigured: isStripeConfigured(),
    resendConfigured: isResendConfigured(),
  });
}
