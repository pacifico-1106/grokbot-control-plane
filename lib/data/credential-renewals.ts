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

/**
 * Reuse rejected/expired/held_blocked rows instead of a partial unique.
 * unique (old_credential_id, threshold) is the design invariant; REUSABLE
 * states already exist; a new row per attempt would need a schema change
 * and would leave stale approval_id values on leftover open-looking rows.
 */
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
/** Demo CAS nonce — never copied onto CredentialRenewalRow / logs. */
const demoClaimTokens = new Map<string, string>();

export type DemoOverlapCredential = {
  id: string;
  orgId: string;
  employeeId: string;
  secretHash: string;
  oldSecretHash: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt?: string | null;
};

const demoOverlapCredentials = new Map<string, DemoOverlapCredential>();
/** Tests only: next demo revoke returns false (do not treat old as dead). */
let demoOverlapRevokeFail = false;
/** Tests only: attach / fingerprint-move / mint cleanup fail closed. */
let demoOverlapAttachFail = false;
let demoOverlapFingerprintMoveFail = false;
let demoOverlapCleanupFail = false;

export function demoSetOverlapRevokeFail(fail: boolean): void {
  demoOverlapRevokeFail = fail;
}

export function demoSetOverlapAttachFail(fail: boolean): void {
  demoOverlapAttachFail = fail;
}

export function demoSetOverlapFingerprintMoveFail(fail: boolean): void {
  demoOverlapFingerprintMoveFail = fail;
}

export function demoOverlapFingerprintMoveShouldFail(): boolean {
  return demoOverlapFingerprintMoveFail;
}

export function demoSetOverlapCleanupFail(fail: boolean): void {
  demoOverlapCleanupFail = fail;
}

/** Tests / demo only. */
export function demoResetCredentialRenewals(): void {
  demoRows.clear();
  demoClaimTokens.clear();
  demoOverlapCredentials.clear();
  demoOverlapRevokeFail = false;
  demoOverlapAttachFail = false;
  demoOverlapFingerprintMoveFail = false;
  demoOverlapCleanupFail = false;
}

/** Tests / demo only — inspect rows in any state (including rejected / expired). */
export function demoListCredentialRenewals(): CredentialRenewalRow[] {
  return [...demoRows.values()].map(withoutSecrets);
}

/** Tests / demo only. */
export function demoPatchCredentialRenewal(
  id: string,
  patch: Partial<CredentialRenewalRow>
): CredentialRenewalRow | null {
  const row = demoRows.get(id);
  if (!row) return null;
  const next = { ...row, ...patch };
  demoRows.set(id, next);
  return withoutSecrets(next);
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
  const copy = { ...row } as CredentialRenewalRow & {
    claim_token?: unknown;
    claimToken?: unknown;
  };
  delete copy.claim_token;
  delete copy.claimToken;
  return copy;
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
      // Same unique (old_credential_id, threshold) as production: old_revoked etc. cannot insert.
      return null;
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

/**
 * Close a pending_approval row when its ticket is rejected or expired.
 * CAS: only the matching approval_id still in pending_approval moves.
 */
export async function markCredentialRenewalClosed(input: {
  orgId: string;
  approvalId: string;
  state: "rejected" | "expired";
}): Promise<CredentialRenewalRow | null> {
  if (!input.orgId || !input.approvalId) return null;
  if (input.state !== "rejected" && input.state !== "expired") return null;
  if (isDemoMode()) {
    const row = [...demoRows.values()].find(
      (r) => r.orgId === input.orgId && r.approvalId === input.approvalId && r.state === "pending_approval"
    );
    if (!row) return null;
    const next = { ...row, state: input.state };
    demoRows.set(row.id, next);
    return withoutSecrets(next);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("credential_renewals")
    .update({ state: input.state })
    .eq("org_id", input.orgId)
    .eq("approval_id", input.approvalId)
    .eq("state", "pending_approval")
    .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
    .maybeSingle();
  if (error || !data) return null;
  return withoutSecrets(mapRow(data as Record<string, unknown>));
}

export async function listPendingApprovalCredentialRenewals(orgId: string): Promise<CredentialRenewalRow[]> {
  if (!orgId) return [];
  if (isDemoMode()) {
    return [...demoRows.values()]
      .filter((r) => r.orgId === orgId && r.state === "pending_approval")
      .map(withoutSecrets);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("credential_renewals")
    .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
    .eq("org_id", orgId)
    .eq("state", "pending_approval");
  if (error || !data) return [];
  return data.map((row) => withoutSecrets(mapRow(row as Record<string, unknown>)));
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

function rpcFailed(error: { message?: string } | null): false {
  if (!error) return false;
  const msg = String(error.message || "");
  if (msg.includes("invalid_claim_token")) throw new Error("invalid_claim_token");
  if (msg.includes("credential_renewal_revoke_incomplete")) throw new Error("credential_renewal_revoke_incomplete");
  if (msg.includes("credential_renewal_switchover_incomplete")) throw new Error("credential_renewal_switchover_incomplete");
  return false;
}

export async function claimCredentialRenewal(input: {
  id: string;
  orgId: string;
  employeeId: string;
  token: string;
  at: string;
}): Promise<boolean> {
  if (!input.token || input.token.length < 16) throw new Error("invalid_claim_token");
  if (isDemoMode()) {
    const row = demoRows.get(input.id);
    if (!row || row.orgId !== input.orgId || row.employeeId !== input.employeeId) return false;
    if (row.state !== "claimable" || row.claimedAt || demoClaimTokens.has(row.id)) return false;
    const until = row.claimableUntil ? Date.parse(row.claimableUntil) : NaN;
    if (!Number.isFinite(until) || until < Date.now()) return false;
    demoClaimTokens.set(row.id, input.token);
    demoRows.set(row.id, { ...row, state: "claimed", claimedAt: input.at });
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("claim_credential_renewal", {
    p_id: input.id,
    p_org: input.orgId,
    p_employee: input.employeeId,
    p_token: input.token,
    p_at: input.at,
  });
  if (error) return rpcFailed(error);
  return data === true;
}

/** R8: same CAS as claim, plus pin mode=gen1_http. */
export async function claimCredentialRenewalGen1Http(input: {
  id: string;
  orgId: string;
  employeeId: string;
  token: string;
  at: string;
}): Promise<boolean> {
  if (!input.token || input.token.length < 16) throw new Error("invalid_claim_token");
  if (isDemoMode()) {
    const row = demoRows.get(input.id);
    if (!row || row.orgId !== input.orgId || row.employeeId !== input.employeeId) return false;
    if (row.state !== "claimable" || row.claimedAt || demoClaimTokens.has(row.id)) return false;
    if (row.mode !== "gen2" && row.mode !== "gen1_http") return false;
    const until = row.claimableUntil ? Date.parse(row.claimableUntil) : NaN;
    if (!Number.isFinite(until) || until < Date.now()) return false;
    demoClaimTokens.set(row.id, input.token);
    demoRows.set(row.id, { ...row, state: "claimed", claimedAt: input.at, mode: "gen1_http" });
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("claim_credential_renewal_gen1_http", {
    p_id: input.id,
    p_org: input.orgId,
    p_employee: input.employeeId,
    p_token: input.token,
    p_at: input.at,
  });
  if (error) return rpcFailed(error);
  return data === true;
}

export async function releaseCredentialRenewal(input: {
  id: string;
  orgId: string;
  token: string;
}): Promise<boolean> {
  if (!input.token) return false;
  if (isDemoMode()) {
    if (demoOverlapCleanupFail) return false;
    const row = demoRows.get(input.id);
    if (!row || row.orgId !== input.orgId || row.state !== "claimed" || row.newCredentialId) return false;
    if (demoClaimTokens.get(row.id) !== input.token) return false;
    demoClaimTokens.delete(row.id);
    const { demoGetEmployeeHold, demoGetOrgHold } = await import("@/lib/safety/hold");
    const held = Boolean(demoGetEmployeeHold(row.employeeId) || demoGetOrgHold(row.orgId));
    demoRows.set(row.id, { ...row, state: held ? "held_blocked" : "claimable", claimedAt: null });
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("release_credential_renewal", {
    p_id: input.id,
    p_org: input.orgId,
    p_token: input.token,
  });
  if (error) return false;
  return data === true;
}

export async function issueOverlappedNewCredential(input: {
  id: string;
  orgId: string;
  employeeId: string;
  token: string;
  secretHash: string;
  secretPrefix: string;
  expiresAt: string;
  overlapUntil: string;
  oldSecretHash: string;
  scopes: unknown;
  allowedPurposes: unknown;
  approvalPolicy: unknown;
  actionLimits: unknown;
  spend: unknown;
  allowedAccounts: unknown;
}): Promise<{ newCredentialId: string; generation: number } | null> {
  if (!input.token || !input.secretHash) return null;
  if (isDemoMode()) {
    if (demoOverlapAttachFail) return null;
    const inserted = await insertOverlapCredentialRow({
      orgId: input.orgId,
      employeeId: input.employeeId,
      secretHash: input.secretHash,
      secretPrefix: input.secretPrefix,
      expiresAt: input.expiresAt,
      oldSecretHash: input.oldSecretHash,
      scopes: input.scopes,
      allowedPurposes: input.allowedPurposes,
      approvalPolicy: input.approvalPolicy,
      actionLimits: input.actionLimits,
      spend: input.spend,
      allowedAccounts: input.allowedAccounts,
    });
    if (!inserted) return null;
    try {
      const { bumpCredentialGenerationKeepFingerprint } = await import("@/lib/data/bindings");
      const bumped = await bumpCredentialGenerationKeepFingerprint(input.employeeId, input.orgId);
      const attached = await attachOverlappedNewCredential({
        id: input.id,
        orgId: input.orgId,
        token: input.token,
        newCredentialId: inserted,
        overlapUntil: input.overlapUntil,
      });
      if (!attached) throw new Error("overlap_attach_failed");
      return { newCredentialId: inserted, generation: bumped.generation };
    } catch {
      await revokeInsertedOverlapCredential({ orgId: input.orgId, credentialId: inserted });
      return null;
    }
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.rpc("issue_overlapped_new_credential", {
    p_id: input.id,
    p_org: input.orgId,
    p_employee: input.employeeId,
    p_token: input.token,
    p_secret_hash: input.secretHash,
    p_secret_prefix: input.secretPrefix,
    p_expires_at: input.expiresAt,
    p_overlap_until: input.overlapUntil,
    p_scopes: input.scopes,
    p_allowed_purposes: input.allowedPurposes,
    p_approval_policy: input.approvalPolicy,
    p_action_limits: input.actionLimits,
    p_spend: input.spend,
    p_allowed_accounts: input.allowedAccounts,
  });
  if (error) {
    rpcFailed(error);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const id = row && typeof row === "object" ? String((row as { new_credential_id?: string }).new_credential_id || "") : "";
  const generation = row && typeof row === "object" ? Number((row as { generation?: number }).generation) : NaN;
  if (!id || !Number.isFinite(generation)) return null;
  return { newCredentialId: id, generation };
}

export async function attachOverlappedNewCredential(input: {
  id: string;
  orgId: string;
  token: string;
  newCredentialId: string;
  overlapUntil: string;
}): Promise<boolean> {
  if (!input.token || !input.newCredentialId) return false;
  if (isDemoMode()) {
    if (demoOverlapAttachFail) return false;
    const row = demoRows.get(input.id);
    if (!row || row.orgId !== input.orgId || row.state !== "claimed" || row.newCredentialId) return false;
    if (demoClaimTokens.get(row.id) !== input.token) return false;
    demoRows.set(row.id, {
      ...row,
      newCredentialId: input.newCredentialId,
      overlapUntil: input.overlapUntil,
    });
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("attach_overlapped_new_credential", {
    p_id: input.id,
    p_org: input.orgId,
    p_token: input.token,
    p_new: input.newCredentialId,
    p_overlap_until: input.overlapUntil,
  });
  if (error) return rpcFailed(error);
  return data === true;
}

async function demoCompleteSwitchover(input: {
  renewalId: string;
  orgId: string;
  employeeId: string;
  oldCredentialId: string;
  newCredentialId: string;
}): Promise<boolean> {
  if (demoOverlapRevokeFail) return false;
  const row = demoRows.get(input.renewalId);
  if (!row || row.orgId !== input.orgId || row.employeeId !== input.employeeId) return false;
  if (row.oldCredentialId !== input.oldCredentialId || row.newCredentialId !== input.newCredentialId) return false;
  if (row.state !== "claimed" && row.state !== "old_revoked") return false;
  const neu = demoOverlapCredentials.get(input.newCredentialId);
  if (neu?.revokedAt) return false;
  const snapshot = { ...row };
  const oldSnap = [...demoOverlapCredentials.values()].find((c) => c.id === input.oldCredentialId);
  const { getBinding } = await import("@/lib/data/bindings");
  const oldHash =
    oldSnap?.secretHash ||
    neu?.oldSecretHash ||
    (await getBinding(input.employeeId))?.credentialFingerprint ||
    "";
  const newHash = neu?.secretHash || "";
  if (demoOverlapFingerprintMoveFail) return false;
  try {
    if (oldSnap) {
      demoOverlapCredentials.set(oldSnap.id, { ...oldSnap, revokedAt: oldSnap.revokedAt ?? new Date().toISOString() });
    }
    const now = new Date().toISOString();
    demoRows.set(row.id, { ...row, state: "old_revoked", oldRevokedAt: row.oldRevokedAt ?? now });
    if (oldHash && newHash) {
      const { moveBindingFingerprintIfCurrent } = await import("@/lib/data/bindings");
      const moved = await moveBindingFingerprintIfCurrent(input.employeeId, input.orgId, oldHash, newHash);
      if (!moved) throw new Error("fingerprint_move_failed");
    } else {
      throw new Error("fingerprint_move_failed");
    }
    return true;
  } catch {
    demoRows.set(row.id, snapshot);
    if (oldSnap) demoOverlapCredentials.set(oldSnap.id, oldSnap);
    return false;
  }
}

export async function completeOverlappedCredentialSwitchover(input: {
  renewalId: string;
  orgId: string;
  employeeId: string;
  oldCredentialId: string;
  newCredentialId: string;
}): Promise<boolean> {
  if (isDemoMode()) return demoCompleteSwitchover(input);
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("complete_overlapped_credential_switchover", {
    p_renewal: input.renewalId,
    p_org: input.orgId,
    p_employee: input.employeeId,
    p_old: input.oldCredentialId,
    p_new: input.newCredentialId,
    p_require_operable: true,
  });
  if (error) return rpcFailed(error);
  return data === true;
}

export async function revokeExpiredOverlappedOldCredential(input: {
  renewalId: string;
  orgId: string;
  oldCredentialId: string;
  newCredentialId: string;
  at?: Date;
}): Promise<"switched" | "expired" | "unused_new_revoked" | null> {
  const at = input.at ?? new Date();
  if (isDemoMode()) {
    const row = demoRows.get(input.renewalId);
    if (!row || row.orgId !== input.orgId) return null;
    if (row.oldCredentialId !== input.oldCredentialId || row.newCredentialId !== input.newCredentialId) return null;
    const until = row.overlapUntil ? Date.parse(row.overlapUntil) : NaN;
    if (!Number.isFinite(until) || until >= at.getTime()) return null;
    const neu = row.newCredentialId ? demoOverlapCredentials.get(row.newCredentialId) : null;
    if (neu?.revokedAt) {
      if (row.state === "claimed") demoRows.set(row.id, { ...row, state: "expired" });
      return "expired";
    }
    if (!neu?.lastUsedAt) {
      if (neu) {
        demoOverlapCredentials.set(neu.id, { ...neu, revokedAt: neu.revokedAt ?? new Date().toISOString() });
      }
      if (row.state === "claimed") demoRows.set(row.id, { ...row, state: "expired" });
      return "unused_new_revoked";
    }
    const ok = await demoCompleteSwitchover({
      renewalId: input.renewalId,
      orgId: input.orgId,
      employeeId: row.employeeId,
      oldCredentialId: input.oldCredentialId,
      newCredentialId: input.newCredentialId,
    });
    return ok ? "switched" : null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.rpc("revoke_expired_overlapped_old_credential", {
    p_renewal: input.renewalId,
    p_org: input.orgId,
    p_old: input.oldCredentialId,
    p_new: input.newCredentialId,
    p_at: at.toISOString(),
  });
  if (error) {
    rpcFailed(error);
    return null;
  }
  if (data === "switched" || data === "expired" || data === "unused_new_revoked") return data;
  return null;
}

export async function blockClaimableCredentialRenewalsOnHold(input: {
  orgId: string;
  employeeId?: string | null;
}): Promise<number> {
  if (!input.orgId) return 0;
  if (isDemoMode()) {
    let n = 0;
    for (const row of demoRows.values()) {
      if (row.orgId !== input.orgId || row.state !== "claimable") continue;
      if (input.employeeId && row.employeeId !== input.employeeId) continue;
      demoRows.set(row.id, { ...row, state: "held_blocked" });
      n += 1;
    }
    return n;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return 0;
  const { data, error } = await admin.rpc("block_claimable_credential_renewals_on_hold_apply", {
    p_org: input.orgId,
    p_employee: input.employeeId ?? null,
  });
  if (error) return 0;
  return typeof data === "number" ? data : Number(data) || 0;
}

export async function abortMintedCredentialRenewal(input: {
  id: string;
  orgId: string;
  token: string;
  newCredentialId: string;
}): Promise<boolean> {
  if (!input.id || !input.orgId || !input.token || !input.newCredentialId) return false;
  if (isDemoMode()) {
    const row = demoRows.get(input.id);
    if (!row || row.orgId !== input.orgId || row.state !== "claimed") return false;
    if (demoClaimTokens.get(row.id) !== input.token) return false;
    if (row.newCredentialId !== input.newCredentialId) return false;
    try {
      await revokeInsertedOverlapCredential({ orgId: input.orgId, credentialId: input.newCredentialId });
    } catch {
      return false;
    }
    demoRows.set(row.id, { ...row, newCredentialId: null, overlapUntil: null });
    return releaseCredentialRenewal({ id: input.id, orgId: input.orgId, token: input.token });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("abort_minted_credential_renewal", {
    p_id: input.id,
    p_org: input.orgId,
    p_token: input.token,
    p_new: input.newCredentialId,
  });
  if (error) return false;
  return data === true;
}

export async function findClaimedOverlapByNewCredential(
  orgId: string,
  newCredentialId: string
): Promise<CredentialRenewalRow | null> {
  if (!orgId || !newCredentialId) return null;
  if (isDemoMode()) {
    const rows = [...demoRows.values()].filter(
      (r) => r.orgId === orgId && r.newCredentialId === newCredentialId && r.state === "claimed"
    );
    return rows[0] ? withoutSecrets(rows[0]) : null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("credential_renewals")
    .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
    .eq("org_id", orgId)
    .eq("new_credential_id", newCredentialId)
    .eq("state", "claimed")
    .maybeSingle();
  if (error || !data) return null;
  return withoutSecrets(mapRow(data as Record<string, unknown>));
}

export async function listExpiredOverlapRenewals(now?: Date): Promise<CredentialRenewalRow[]> {
  const at = now ?? new Date();
  if (isDemoMode()) {
    return [...demoRows.values()]
      .filter((r) => {
        if (r.state !== "claimed" || !r.newCredentialId || r.oldRevokedAt) return false;
        const until = r.overlapUntil ? Date.parse(r.overlapUntil) : NaN;
        return Number.isFinite(until) && until < at.getTime();
      })
      .map(withoutSecrets);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("credential_renewals")
    .select("id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimable_until, overlap_until, claimed_at, old_revoked_at, created_at")
    .eq("state", "claimed")
    .not("new_credential_id", "is", null)
    .is("old_revoked_at", null)
    .lt("overlap_until", at.toISOString());
  if (error || !data) return [];
  return data.map((row) => withoutSecrets(mapRow(row as Record<string, unknown>)));
}

export async function getCredentialSecretHash(credentialId: string): Promise<string | null> {
  if (!credentialId) return null;
  if (isDemoMode()) {
    const cred = demoOverlapCredentials.get(credentialId);
    return cred?.secretHash ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.from("credentials").select("secret_hash").eq("id", credentialId).maybeSingle();
  if (error || !data) return null;
  const hash = (data as { secret_hash?: string }).secret_hash;
  return typeof hash === "string" && hash ? hash : null;
}

export function demoPutOverlapCredential(row: DemoOverlapCredential): DemoOverlapCredential {
  demoOverlapCredentials.set(row.id, { ...row });
  return { ...row };
}

export function demoGetOverlapCredentialByHash(hash: string): DemoOverlapCredential | null {
  if (!hash) return null;
  for (const row of demoOverlapCredentials.values()) {
    if (row.secretHash === hash) return { ...row };
  }
  return null;
}

export function demoGetOverlapCredential(id: string): DemoOverlapCredential | null {
  const row = demoOverlapCredentials.get(id);
  return row ? { ...row } : null;
}

export async function insertOverlapCredentialRow(input: {
  orgId: string;
  employeeId: string;
  secretHash: string;
  secretPrefix: string;
  expiresAt: string;
  oldSecretHash: string;
  scopes: unknown;
  allowedPurposes: unknown;
  approvalPolicy: unknown;
  actionLimits: unknown;
  spend: unknown;
  allowedAccounts: unknown;
}): Promise<string | null> {
  if (isDemoMode()) {
    const id = `cred_ov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    demoPutOverlapCredential({
      id,
      orgId: input.orgId,
      employeeId: input.employeeId,
      secretHash: input.secretHash,
      oldSecretHash: input.oldSecretHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
    return id;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("credentials")
    .insert({
      org_id: input.orgId,
      employee_id: input.employeeId,
      secret_hash: input.secretHash,
      secret_prefix: input.secretPrefix,
      scopes: input.scopes,
      allowed_purposes: input.allowedPurposes,
      approval_policy: input.approvalPolicy,
      action_limits: input.actionLimits,
      spend: input.spend ?? null,
      allowed_accounts: input.allowedAccounts ?? [],
      expires_at: input.expiresAt,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return null;
  return String((data as { id: string }).id);
}

export async function revokeInsertedOverlapCredential(input: {
  orgId: string;
  credentialId: string;
}): Promise<void> {
  if (!input.credentialId) return;
  if (isDemoMode()) {
    if (demoOverlapCleanupFail) throw new Error("overlap_cleanup_failed");
    const row = demoOverlapCredentials.get(input.credentialId);
    if (row) demoOverlapCredentials.set(row.id, { ...row, revokedAt: row.revokedAt ?? new Date().toISOString() });
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin
    .from("credentials")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.credentialId)
    .eq("org_id", input.orgId)
    .is("revoked_at", null);
}
