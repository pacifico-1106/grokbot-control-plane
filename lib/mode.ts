/**
 * Dual-mode switch: DEMO (in-memory) vs production (Supabase).
 * Real keys are injected LAST — never require live Supabase to build/run.
 */

function looksLikePlaceholder(value: string | undefined | null): boolean {
  if (value == null) return true;
  const v = value.trim();
  if (!v) return true;
  const lower = v.toLowerCase();
  return (
    lower.startsWith("replace_me") ||
    lower.includes("your_project") ||
    lower.includes("placeholder") ||
    lower === "changeme" ||
    lower.includes("example.supabase.co")
  );
}

/**
 * True when Supabase URL / anon / service-role look missing or placeholder.
 * Demo UX (hire / team / approvals) stays on in-memory stores.
 */
export function isDemoMode(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return (
    looksLikePlaceholder(url) ||
    looksLikePlaceholder(anon) ||
    looksLikePlaceholder(service)
  );
}

/** Inverse of isDemoMode — safe to construct admin/browser clients. */
export function isSupabaseConfigured(): boolean {
  return !isDemoMode();
}

export function isStripeConfigured(): boolean {
  return !looksLikePlaceholder(process.env.STRIPE_SECRET_KEY);
}

export function isResendConfigured(): boolean {
  return !looksLikePlaceholder(process.env.RESEND_API_KEY);
}

/** Label for API responses / UI chips. */
export function runtimeModeLabel(): "demo" | "production" {
  return isDemoMode() ? "demo" : "production";
}
