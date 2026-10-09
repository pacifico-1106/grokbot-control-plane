/**
 * A1 scheduling policy storage (org and employee-level).
 * Fallback order: employee override → org policy → convenience default.
 * Demo mode uses in-memory store; production uses Supabase.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import {
  defaultSchedulingPolicy,
  normalizeSchedulingPolicy,
} from "@/lib/scheduling-policy/validate";
import type { OrgSchedulingPolicy } from "@/lib/types";
import {
  assertDemoContextUnchanged,
  assertGuardFor,
  casResult,
  type ApproverContextGuard,
} from "@/lib/approver-authority/context-cas";

let demoSchedulingPolicy: OrgSchedulingPolicy | null = null;
const demoEmployeeSchedulingPolicies = new Map<string, OrgSchedulingPolicy | null>();

export type SchedulingPolicySource = "employee" | "org" | "default";

export type EffectiveSchedulingPolicy = {
  policy: OrgSchedulingPolicy;
  source: SchedulingPolicySource;
  employeeOverride: OrgSchedulingPolicy | null;
  orgPolicy: OrgSchedulingPolicy | null;
};

/**
 * Get org-level scheduling policy (raw). Returns null if none explicitly set.
 * Use getOrgSchedulingPolicy for the effective policy with fallback to default.
 */
async function getOrgSchedulingPolicyRaw(
  orgId?: string | null
): Promise<OrgSchedulingPolicy | null> {
  if (isDemoMode()) {
    return demoSchedulingPolicy;
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) {
    return null;
  }
  const { data } = await admin
    .from("orgs")
    .select("scheduling_policy")
    .eq("id", orgId)
    .maybeSingle();
  const raw = (data as { scheduling_policy?: unknown } | null)?.scheduling_policy;
  if (!raw) {
    return null;
  }
  return normalizeSchedulingPolicy(raw);
}

export async function getOrgSchedulingPolicy(
  orgId?: string | null
): Promise<OrgSchedulingPolicy> {
  const raw = await getOrgSchedulingPolicyRaw(orgId);
  return raw ?? defaultSchedulingPolicy();
}

/**
 * Optional TOCTOU guard (APPROVER_AUTHORITY_ENABLED, approval-executed
 * schedulingPolicy.patch): the write only happens if the stored org (and
 * employee) policy still equals the snapshot pinned by the guard — demo:
 * compared right before the write; production: one RPC that locks, compares
 * and writes. Mismatch → ApproverContextChangedError, nothing written.
 * Without a guard: today's write.
 */
export type SchedulingPolicyWriteOptions = { contextGuard?: ApproverContextGuard };

/** Demo store, raw (what getEffectiveSchedulingPolicy returns in demo), for the guard snapshot. */
export function demoSchedulingPolicySnapshot(employeeId: string | null): { org: OrgSchedulingPolicy | null; employee: OrgSchedulingPolicy | null } {
  return {
    org: demoSchedulingPolicy,
    employee: employeeId ? demoEmployeeSchedulingPolicies.get(employeeId) ?? null : null,
  };
}

function demoGuardCurrent(employeeId: string | null): Record<string, unknown> {
  const raw = demoSchedulingPolicySnapshot(employeeId);
  return employeeId ? { org: raw.org, employee: raw.employee } : { org: raw.org };
}

async function casWriteSchedulingPolicy(
  guard: ApproverContextGuard,
  orgId: string,
  employeeId: string | null,
  next: OrgSchedulingPolicy | null
): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin.rpc("approver_cas_write_scheduling_policy", {
    p_org: orgId,
    p_employee: employeeId,
    p_approval: guard.approvalId,
    p_fingerprint: guard.fingerprint,
    p_expected: guard.expected,
    p_target: employeeId ? "employee" : "org",
    p_policy: next,
  });
  casResult(data, error);
}

export async function setOrgSchedulingPolicy(
  orgId: string,
  policy: OrgSchedulingPolicy,
  options: SchedulingPolicyWriteOptions = {}
): Promise<OrgSchedulingPolicy> {
  const guard = options.contextGuard;
  if (guard) assertGuardFor(guard, "schedulingPolicy.patch", null);
  const next = normalizeSchedulingPolicy({
    ...policy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  });
  if (isDemoMode()) {
    if (guard) assertDemoContextUnchanged(guard, demoGuardCurrent(null));
    demoSchedulingPolicy = next;
    return next;
  }
  if (guard) {
    await casWriteSchedulingPolicy(guard, orgId, null, next);
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { error } = await admin
    .from("orgs")
    .update({
      scheduling_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
  if (error) throw new Error(error.message);
  return next;
}

export function resetDemoSchedulingPolicy(): void {
  demoSchedulingPolicy = null;
  demoEmployeeSchedulingPolicies.clear();
}

/**
 * Get employee-level scheduling policy override.
 * Returns null if no override is set (inherit org policy).
 */
export async function getEmployeeSchedulingPolicy(
  employeeId?: string | null
): Promise<OrgSchedulingPolicy | null> {
  if (!employeeId) return null;

  if (isDemoMode()) {
    return demoEmployeeSchedulingPolicies.get(employeeId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data } = await admin
    .from("employees")
    .select("scheduling_policy")
    .eq("id", employeeId)
    .maybeSingle();

  const raw = (data as { scheduling_policy?: unknown } | null)?.scheduling_policy;
  if (!raw) return null;

  return normalizeSchedulingPolicy(raw);
}

/**
 * Set or clear employee-level scheduling policy override.
 * Pass null to clear the override and inherit org policy.
 */
export async function setEmployeeSchedulingPolicy(
  employeeId: string,
  orgId: string,
  policy: OrgSchedulingPolicy | null,
  options: SchedulingPolicyWriteOptions = {}
): Promise<OrgSchedulingPolicy | null> {
  const guard = options.contextGuard;
  if (guard) assertGuardFor(guard, "schedulingPolicy.patch", employeeId);
  const next = policy
    ? normalizeSchedulingPolicy({
        ...policy,
        updatedAt: new Date().toISOString(),
        updatedBy: "admin_mcp",
      })
    : null;

  if (isDemoMode()) {
    if (guard) assertDemoContextUnchanged(guard, demoGuardCurrent(employeeId));
    if (next === null) {
      demoEmployeeSchedulingPolicies.delete(employeeId);
    } else {
      demoEmployeeSchedulingPolicies.set(employeeId, next);
    }
    return next;
  }

  if (guard) {
    await casWriteSchedulingPolicy(guard, orgId, employeeId, next);
    return next;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const { error } = await admin
    .from("employees")
    .update({
      scheduling_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", employeeId)
    .eq("org_id", orgId);

  if (error) throw new Error(error.message);
  return next;
}

/**
 * Get effective scheduling policy with fallback order:
 * employee override → org policy → convenience default.
 *
 * @param orgId - Organization ID
 * @param employeeId - Optional employee ID for per-employee lookup
 * @returns Effective policy with source metadata
 */
export async function getEffectiveSchedulingPolicy(
  orgId?: string | null,
  employeeId?: string | null
): Promise<EffectiveSchedulingPolicy> {
  const employeeOverride = employeeId
    ? await getEmployeeSchedulingPolicy(employeeId)
    : null;
  const orgPolicyRaw = orgId ? await getOrgSchedulingPolicyRaw(orgId) : null;
  const defaultPolicy = defaultSchedulingPolicy();

  if (employeeOverride) {
    return {
      policy: employeeOverride,
      source: "employee",
      employeeOverride,
      orgPolicy: orgPolicyRaw,
    };
  }

  if (orgPolicyRaw) {
    return {
      policy: orgPolicyRaw,
      source: "org",
      employeeOverride: null,
      orgPolicy: orgPolicyRaw,
    };
  }

  return {
    policy: defaultPolicy,
    source: "default",
    employeeOverride: null,
    orgPolicy: null,
  };
}

/**
 * Record high-risk consent for enabling automation levels beyond always_human.
 * Called when tenant acknowledges the risk of enabling risk_based/conditional/full_auto.
 */
export async function recordHighRiskConsent(
  orgId: string,
  consentBy: string
): Promise<OrgSchedulingPolicy> {
  const current = await getOrgSchedulingPolicy(orgId);
  const next: OrgSchedulingPolicy = {
    ...current,
    highRiskConsentAt: new Date().toISOString(),
    highRiskConsentBy: consentBy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
  return setOrgSchedulingPolicy(orgId, next);
}
