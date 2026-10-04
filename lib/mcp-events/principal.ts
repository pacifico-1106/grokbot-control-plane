/**
 * The subscription principal is the employee badge (gb_emp_) that subscribed:
 * org + employee + credential generation (+ fingerprint). Re-checked on EVERY
 * delivery attempt; any change (binding revoked, badge rotated / revoked /
 * expired, employee suspended or moved) stops delivery immediately — the
 * server cannot rely on the client (ChatGPT has no `terminated` support).
 */
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { getBinding, getEmployeeById } from "@/lib/data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { SubscriptionRow } from "./store";

export function principalFor(cred: Pick<ResolvedEmployeeCredential, "orgId" | "employeeId" | "generation">): string {
  return `emp:${cred.orgId}:${cred.employeeId}:g${cred.generation}`;
}

export type PrincipalCheck = { ok: true } | { ok: false; reason: string };

export async function checkSubscriptionPrincipal(
  sub: Pick<SubscriptionRow, "orgId" | "employeeId" | "credentialGeneration" | "credentialFingerprint" | "credentialId">,
  nowMs: number
): Promise<PrincipalCheck> {
  const binding = await getBinding(sub.employeeId);
  if (!binding) return { ok: false, reason: "binding_missing" };
  if (binding.orgId && binding.orgId !== sub.orgId) return { ok: false, reason: "org_mismatch" };
  if (binding.status === "revoked") return { ok: false, reason: "binding_revoked" };
  if (binding.credentialGeneration !== sub.credentialGeneration) return { ok: false, reason: "credential_rotated" };
  if (binding.credentialFingerprint && binding.credentialFingerprint !== sub.credentialFingerprint) {
    return { ok: false, reason: "credential_rotated" };
  }
  const employee = await getEmployeeById(sub.employeeId);
  if (!employee || employee.orgId !== sub.orgId) return { ok: false, reason: "employee_missing" };
  if (employee.status === "suspended") return { ok: false, reason: "employee_suspended" };
  if (!isDemoMode() && sub.credentialId) {
    const admin = createSupabaseAdminClient();
    if (!admin) return { ok: false, reason: "credential_unverifiable" };
    const { data, error } = await admin.from("credentials").select("revoked_at, expires_at")
      .eq("id", sub.credentialId).eq("employee_id", sub.employeeId).maybeSingle();
    if (error || !data) return { ok: false, reason: "credential_missing" };
    const row = data as { revoked_at: string | null; expires_at: string | null };
    if (row.revoked_at) return { ok: false, reason: "credential_revoked" };
    if (row.expires_at && Date.parse(row.expires_at) < nowMs) return { ok: false, reason: "credential_expired" };
  }
  return { ok: true };
}

// ---- reader seam (stubs; implemented in the fix commit) ----------------------
export type Read<T> = { state: "found"; value: T } | { state: "missing" } | { state: "error"; detail: string };
export type PrincipalReader = {
  binding(employeeId: string): Promise<Read<{ orgId: string | null; status: string; credentialGeneration: number; credentialFingerprint: string | null }>>;
  employee(employeeId: string): Promise<Read<{ orgId: string; status: string }>>;
  credential(credentialId: string, employeeId: string): Promise<Read<{ revokedAt: string | null; expiresAt: string | null }>>;
};
export function defaultPrincipalReader(): PrincipalReader { throw new Error("not_implemented"); }
export function supabasePrincipalReader(_client: unknown): PrincipalReader { void _client; throw new Error("not_implemented"); }
export function __setPrincipalReaderForTests(_r: PrincipalReader | null): void { void _r; }
