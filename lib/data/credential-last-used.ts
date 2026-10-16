/**
 * credentials.last_used_at: best-effort touch after a successful 社員証
 * resolve. Production: public.touch_credential_last_used — one conditional
 * UPDATE, at most once per 5 minutes per credential. Never throws; never
 * blocks auth. Demo / missing RPC / non-uuid → no-op.
 */
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isDemoMode } from "@/lib/mode";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matches the SQL function's `now() - interval '5 minutes'` window. */
export const CREDENTIAL_LAST_USED_MIN_INTERVAL = "00:05:00";

export async function touchCredentialLastUsed(credentialId: string | null | undefined): Promise<void> {
  try {
    if (!credentialId || !UUID.test(credentialId)) return;
    if (isDemoMode()) return;
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    await admin.rpc("touch_credential_last_used", { p_id: credentialId });
  } catch {
    // best-effort
  }
}
