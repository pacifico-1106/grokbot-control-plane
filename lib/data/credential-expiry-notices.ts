/**
 * Storage for the 社員証 pre-expiry notice (CREDENTIAL_EXPIRY_NOTICE_ENABLED).
 * - credential_expiry_notices (migration 20261012100000): dedup claim per
 *   credential × threshold; the primary key makes a second claim fail.
 * - listExpiringCredentials: non-revoked credentials expiring inside the
 *   horizon, with their employee's org + status (ids / timestamps only — never
 *   secret_hash / secret_prefix).
 * Server-only (service role). Demo mode: in-memory.
 */
import { getRuntimeEmployees } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { Employee } from "@/lib/types";

export type CredentialExpiryThreshold = "7d" | "1d";

export interface ExpiringCredentialRow {
  credentialId: string;
  /** credentials.org_id */
  orgId: string;
  employeeId: string;
  /** employees.org_id (must equal orgId; a mismatch is skipped). null = employee row missing. */
  employeeOrgId: string | null;
  employeeStatus: Employee["status"] | null;
  expiresAt: string;
}

type NoticeKey = Pick<ExpiringCredentialRow, "credentialId" | "orgId" | "employeeId" | "expiresAt">;
export type ClaimResult = "claimed" | "duplicate" | "error";

const MAX_ROWS = 1000;
const demoNotices = new Map<string, { orgId: string; employeeId: string; notifiedAt: number }>();
export function resetDemoCredentialExpiryNotices(): void {
  demoNotices.clear();
}

export async function claimCredentialExpiryNotice(row: NoticeKey, threshold: CredentialExpiryThreshold): Promise<ClaimResult> {
  if (isDemoMode()) {
    const key = `${row.credentialId}:${threshold}`;
    if (demoNotices.has(key)) return "duplicate";
    demoNotices.set(key, { orgId: row.orgId, employeeId: row.employeeId, notifiedAt: Date.now() });
    return "claimed";
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return "error";
  const { error } = await admin.from("credential_expiry_notices").insert({
    credential_id: row.credentialId,
    threshold,
    org_id: row.orgId,
    employee_id: row.employeeId,
    expires_at: row.expiresAt,
  });
  if (!error) return "claimed";
  return (error as { code?: string }).code === "23505" ? "duplicate" : "error";
}

/** Undo a claim whose send failed (scoped to the credential's own org). */
export async function releaseCredentialExpiryNotice(row: NoticeKey, threshold: CredentialExpiryThreshold): Promise<void> {
  if (isDemoMode()) {
    const key = `${row.credentialId}:${threshold}`;
    if (demoNotices.get(key)?.orgId === row.orgId) demoNotices.delete(key);
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin
    .from("credential_expiry_notices")
    .delete()
    .eq("credential_id", row.credentialId)
    .eq("threshold", threshold)
    .eq("org_id", row.orgId);
}

/** Whether this credential × threshold was already claimed (scoped to its org). Error → true (treated as not waiting). */
export async function isCredentialExpiryNoticeClaimed(row: NoticeKey, threshold: CredentialExpiryThreshold): Promise<boolean> {
  if (isDemoMode()) return demoNotices.get(`${row.credentialId}:${threshold}`)?.orgId === row.orgId;
  const admin = createSupabaseAdminClient();
  if (!admin) return true;
  const { data, error } = await admin
    .from("credential_expiry_notices")
    .select("credential_id")
    .eq("credential_id", row.credentialId)
    .eq("threshold", threshold)
    .eq("org_id", row.orgId)
    .maybeSingle();
  if (error) return true;
  return Boolean(data);
}

/** Notices claimed for one org since `since` (per-org daily cap). Error → Infinity (fail closed: send nothing). */
export async function countRecentCredentialExpiryNotices(orgId: string, since: Date): Promise<number> {
  if (isDemoMode()) {
    return [...demoNotices.values()].filter((n) => n.orgId === orgId && n.notifiedAt >= since.getTime()).length;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return Number.POSITIVE_INFINITY;
  const { count, error } = await admin
    .from("credential_expiry_notices")
    .select("credential_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .gte("notified_at", since.toISOString());
  if (error || typeof count !== "number") return Number.POSITIVE_INFINITY;
  return count;
}

/** Non-revoked credentials with now < expires_at <= now + horizon, soonest first. */
export async function listExpiringCredentials(now: Date, horizonMs: number): Promise<ExpiringCredentialRow[]> {
  const until = new Date(now.getTime() + horizonMs);
  if (isDemoMode()) {
    return getRuntimeEmployees()
      .filter((e) => e.credentialId && e.credentialExpiresAt)
      .map((e) => ({
        credentialId: String(e.credentialId),
        orgId: e.orgId,
        employeeId: e.id,
        employeeOrgId: e.orgId,
        employeeStatus: e.status,
        expiresAt: String(e.credentialExpiresAt),
      }))
      .filter((r) => Date.parse(r.expiresAt) > now.getTime() && Date.parse(r.expiresAt) <= until.getTime());
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data: creds, error } = await admin
    .from("credentials")
    .select("id, org_id, employee_id, expires_at")
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString())
    .lte("expires_at", until.toISOString())
    .order("expires_at", { ascending: true })
    .limit(MAX_ROWS);
  if (error || !creds?.length) return [];
  const rows = creds as Array<{ id: string; org_id: string; employee_id: string; expires_at: string }>;
  const ids = [...new Set(rows.map((r) => String(r.employee_id)))];
  const { data: emps, error: empError } = await admin.from("employees").select("id, org_id, status").in("id", ids);
  if (empError) return [];
  const byId = new Map(
    ((emps ?? []) as Array<{ id: string; org_id: string; status: Employee["status"] }>).map((e) => [String(e.id), e])
  );
  return rows.map((r) => {
    const e = byId.get(String(r.employee_id));
    return {
      credentialId: String(r.id),
      orgId: String(r.org_id),
      employeeId: String(r.employee_id),
      employeeOrgId: e ? String(e.org_id) : null,
      employeeStatus: e ? e.status : null,
      expiresAt: String(r.expires_at),
    };
  });
}
