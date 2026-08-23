import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { isDemoMode } from "./mode";

export { isDemoMode, isSupabaseConfigured } from "./mode";

/**
 * Browser / server anon client stub.
 * Returns null in DEMO mode (placeholder / missing keys).
 */
export function createSupabaseBrowserClient(): SupabaseClient | null {
  if (isDemoMode()) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createBrowserClient(url, key);
}

/** Service-role client for API routes (never expose to browser). */
export function createSupabaseAdminClient(): SupabaseClient | null {
  if (isDemoMode()) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Cookie-bound server client for Auth session (RSC / Route Handlers).
 * Pass Next.js cookie store adapters from next/headers.
 */
export function createSupabaseServerClient(cookieStore: {
  getAll: () => { name: string; value: string }[];
  setAll?: (
    cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]
  ) => void;
}): SupabaseClient | null {
  if (isDemoMode()) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        try {
          cookieStore.setAll?.(cookiesToSet);
        } catch {
          /* RSC may be read-only; middleware refreshes session */
        }
      },
    },
  });
}
