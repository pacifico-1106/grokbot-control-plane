import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../supabase";

/** Cookie-bound anon Supabase client for Route Handlers (writes session cookies). */
export async function createRouteSupabase(): Promise<SupabaseClient | null> {
  const cookieStore = await cookies();
  return createSupabaseServerClient({
    getAll: () => cookieStore.getAll(),
    setAll: (cookiesToSet) => {
      cookiesToSet.forEach(({ name, value, options }) => {
        cookieStore.set(name, value, options as never);
      });
    },
  });
}
