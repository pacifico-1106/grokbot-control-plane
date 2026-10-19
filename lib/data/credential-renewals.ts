/**
 * credential_renewals store (CREDENTIAL_AUTO_RENEW_ENABLED).
 * Ids + timestamps only — never 社員証 secret, prefix, hash, public key, or claim_token in logs.
 */
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isDemoMode } from "@/lib/mode";
import type { CredentialAutoRenewState, CredentialAutoRenewThreshold } from "@/lib/employees/credential-auto-renew";

export const OPEN_CREDENTIAL_RENEWAL_STATES: readonly CredentialAutoRenewState[] = [
  "pending_approval",
  "claimable",
  "claimed",
];

export const REUSABLE_CREDENTIAL_RENEWAL_STATES: readonly CredentialAutoRenewState[] = [
  "rejected",
  "expired",
  "held_blocked",
];

export type CredentialRenewalRow = {
  id: string;
  orgId: string;
  employeeId: string;
  oldCredentialId: string;
  newCredentialId: string | null;
  approvalId: string;
  threshold: CredentialAutoRenewThreshold;
  state: CredentialAutoRenewState;
  mode: "gen2" | "gen1_http";
  claimableUntil: string | null;
  overlapUntil: string | null;
  claimedAt: string | null;
  oldRevokedAt: string | null;
  createdAt: string;
};

const demoRows = new Map<string, CredentialRenewalRow>();

/** Tests / demo only. */
export function demoResetCredentialRenewals(): void {
  demoRows.clear();
}

function mapRow(row: Record<string, unknown>): CredentialRenewalRow {
  return {
    id: String(row.id),
    orgId: String(row.org_id ?? row.orgId),
    employeeId: String(row.employee_id ?? row.employeeId),
    oldCredentialId: String(row.old_credential_id ?? row.oldCredentialId),
    newCredentialId: (row.new_credential_id ?? row.newCredentialId) ? String(row.new_credential_id ?? row.newCredentialId) : null,
    approvalId: String(row.approval_id ?? row.approvalId),
    threshold: (row.threshold === "7d" ? "7d" : "now") as CredentialAutoRenewThreshold,
    state: String(row.state) as CredentialAutoRenewState,
    mode: row.mode === "gen1_http" ? "gen1_http" : "gen2",
    claimableUntil: (row.claimable_until ?? row.claimableUntil) ? String(row.claimable_until ?? row.claimableUntil) : null,
    overlapUntil: (row.overlap_until ?? row.overlapUntil) ? String(row.overlap_until ?? row.overlapUntil) : null,
    claimedAt: (row.claimed_at ?? row.claimedAt) ? String(row.claimed_at ?? row.claimedAt) : null,
    oldRevokedAt: (row.old_revoked_at ?? row.oldRevokedAt) ? String(row.old_revoked_at ?? row.oldRevokedAt) : null,
    createdAt: String(row.created_at ?? row.createdAt ?? new Date().toISOString()),
  };
}

function withoutSecrets(row: CredentialRenewalRow): CredentialRenewalRow {
  return { ...row };
}

export async function findOpenCredentialRenewalRow(
  orgId: string,
  employeeId: string
): Promise<CredentialRenewalRow | null> {
  if (!orgId || !employeeId) return null;
  if (isDemoMode()) {
    const rows = [...demoRows.values()].filter(
      (r) => r.orgId === orgId && r.employeeId === employeeId && (OPEN_CREDENTIAL_RENEWAL_STATES as readonly string[]).includes(r.state)
    );
    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return rows[0] ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("credential_renewals")
    .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .in("state", [...OPEN_CREDENTIAL_RENEWAL_STATES])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.[0]) return null;
  return withoutSecrets(mapRow(data[0] as Record<string, unknown>));
}

export async function expireStaleCredentialRenewalRows(input: {
  orgId: string;
  now?: Date;
}): Promise<number> {
  const orgId = input.orgId?.trim();
  if (!orgId) return 0;
  const at = input.now ?? new Date();
  if (isDemoMode()) {
    let n = 0;
    const windowMs = 24 * 60 * 60 * 1000;
    for (const row of demoRows.values()) {
      if (row.orgId !== orgId) continue;
      const claimableUntil = row.claimableUntil ? Date.parse(row.claimableUntil) : NaN;
      const claimedAt = row.claimedAt ? Date.parse(row.claimedAt) : NaN;
      const expireClaimable = row.state === "claimable" && Number.isFinite(claimableUntil) && claimableUntil < at.getTime();
      const expireStuck =
        row.state === "claimed" &&
        !row.newCredentialId &&
        Number.isFinite(claimedAt) &&
        claimedAt + windowMs < at.getTime();
      if (expireClaimable || expireStuck) {
        demoRows.set(row.id, { ...row, state: "expired" });
        n += 1;
      }
    }
    return n;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return 0;
  const { data, error } = await admin.rpc("expire_stale_credential_renewals", {
    p_org: orgId,
    p_at: at.toISOString(),
  });
  if (error) return 0;
  return typeof data === "number" ? data : Number(data) || 0;
}

export async function insertOrReuseCredentialRenewal(input: {
  orgId: string;
  employeeId: string;
  oldCredentialId: string;
  approvalId: string;
  threshold: CredentialAutoRenewThreshold;
}): Promise<CredentialRenewalRow | null> {
  const now = new Date().toISOString();
  if (isDemoMode()) {
    for (const row of demoRows.values()) {
      if (row.orgId !== input.orgId || row.oldCredentialId !== input.oldCredentialId || row.threshold !== input.threshold) continue;
      if ((OPEN_CREDENTIAL_RENEWAL_STATES as readonly string[]).includes(row.state)) return null;
      if ((REUSABLE_CREDENTIAL_RENEWAL_STATES as readonly string[]).includes(row.state)) {
        const next: CredentialRenewalRow = {
          ...row,
          approvalId: input.approvalId,
          employeeId: input.employeeId,
          state: "pending_approval",
          claimableUntil: null,
          overlapUntil: null,
          claimedAt: null,
          oldRevokedAt: null,
          newCredentialId: null,
        };
        demoRows.set(row.id, next);
        return withoutSecrets(next);
      }
    }
    const created: CredentialRenewalRow = {
      id: `crn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      orgId: input.orgId,
      employeeId: input.employeeId,
      oldCredentialId: input.oldCredentialId,
      newCredentialId: null,
      approvalId: input.approvalId,
      threshold: input.threshold,
      state: "pending_approval",
      mode: "gen2",
      claimableUntil: null,
      overlapUntil: null,
      claimedAt: null,
      oldRevokedAt: null,
      createdAt: now,
    };
    demoRows.set(created.id, created);
    return withoutSecrets(created);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data: existing, error: readError } = await admin
    .from("credential_renewals")
    .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
    .eq("org_id", input.orgId)
    .eq("old_credential_id", input.oldCredentialId)
    .eq("threshold", input.threshold)
    .maybeSingle();
  if (readError) return null;
  if (existing) {
    const row = mapRow(existing as Record<string, unknown>);
    if ((OPEN_CREDENTIAL_RENEWAL_STATES as readonly string[]).includes(row.state)) return null;
    if ((REUSABLE_CREDENTIAL_RENEWAL_STATES as readonly string[]).includes(row.state)) {
      const { data: updated, error: updError } = await admin
        .from("credential_renewals")
        .update({
          approval_id: input.approvalId,
          employee_id: input.employeeId,
          state: "pending_approval",
          claimable_until: null,
          overlap_until: null,
          claimed_at: null,
          old_revoked_at: null,
          new_credential_id: null,
          claim_token: null,
        })
        .eq("id", row.id)
        .eq("org_id", input.orgId)
        .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
        .maybeSingle();
      if (updError || !updated) return null;
      return withoutSecrets(mapRow(updated as Record<string, unknown>));
    }
    return null;
  }
  const { data, error } = await admin
    .from("credential_renewals")
    .insert({
      org_id: input.orgId,
      employee_id: input.employeeId,
      old_credential_id: input.oldCredentialId,
      approval_id: input.approvalId,
      threshold: input.threshold,
      state: "pending_approval",
      mode: "gen2",
    })
    .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
    .maybeSingle();
  if (error || !data) return null;
  return withoutSecrets(mapRow(data as Record<string, unknown>));
}

export async function markCredentialRenewalClaimable(input: {
  orgId: string;
  employeeId: string;
  approvalId: string;
  claimableUntil: string;
}): Promise<CredentialRenewalRow | null> {
  if (isDemoMode()) {
    const row = [...demoRows.values()].find(
      (r) =>
        r.orgId === input.orgId &&
        r.employeeId === input.employeeId &&
        r.approvalId === input.approvalId &&
        r.state === "pending_approval"
    );
    if (!row) return null;
    const next = { ...row, state: "claimable" as const, claimableUntil: input.claimableUntil };
    demoRows.set(row.id, next);
    return withoutSecrets(next);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("credential_renewals")
    .update({ state: "claimable", claimable_until: input.claimableUntil })
    .eq("org_id", input.orgId)
    .eq("employee_id", input.employeeId)
    .eq("approval_id", input.approvalId)
    .eq("state", "pending_approval")
    .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
    .maybeSingle();
  if (error || !data) return null;
  return withoutSecrets(mapRow(data as Record<string, unknown>));
}
