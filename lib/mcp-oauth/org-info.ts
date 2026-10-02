/** Small server-only lookups for the consent screen (org name, MFA assurance level). */
import { cookies } from "next/headers";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase";

export async function getOrgName(orgId: string): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return null;
  const { data } = await admin.from("orgs").select("name").eq("id", orgId).maybeSingle();
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Current Supabase AAL ("aal1" | "aal2") for the signed-in user, or null. */
export async function getSessionAal(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createSupabaseServerClient({
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        /* read-only */
      },
    });
    if (!supabase) return null;
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.currentLevel ?? null;
  } catch {
    return null;
  }
}
