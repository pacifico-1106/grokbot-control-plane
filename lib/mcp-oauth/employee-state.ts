/**
 * Current 社員証 state for an employee (used by the OAuth RS on every request):
 * the newest non-revoked credentials row and its expiry. OAuth access can never
 * outlive or outrank the employee's own credential.
 */
import { getEmployeeById } from "@/lib/data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export type CurrentCredential = { credentialId: string; expiresAt: string | null } | null;

export async function getCurrentEmployeeCredential(employeeId: string): Promise<CurrentCredential> {
  if (isDemoMode()) {
    const e = await getEmployeeById(employeeId);
    return e?.credentialId ? { credentialId: e.credentialId, expiresAt: null } : null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("credentials")
    .select("id, expires_at, revoked_at")
    .eq("employee_id", employeeId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; expires_at: string | null };
  return { credentialId: String(row.id), expiresAt: row.expires_at };
}
