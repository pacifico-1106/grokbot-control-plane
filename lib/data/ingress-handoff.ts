/**
 * Ingress handoff policy storage (org and employee-level).
 * Fallback order: employee override → org policy → convenience default.
 * Demo mode uses in-memory store; production uses Supabase.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import {
  defaultIngressHandoffPolicy,
  normalizeIngressHandoffPolicy,
} from "@/lib/ingress-handoff/validate";
import type { OrgIngressHandoffPolicy } from "@/lib/types";

let demoIngressHandoffPolicy: OrgIngressHandoffPolicy | null = null;
const demoEmployeeIngressHandoffPolicies = new Map<string, OrgIngressHandoffPolicy | null>();

export type IngressHandoffPolicySource = "employee" | "org" | "default";

export type EffectiveIngressHandoffPolicy = {
  policy: OrgIngressHandoffPolicy;
  source: IngressHandoffPolicySource;
  employeeOverride: OrgIngressHandoffPolicy | null;
  orgPolicy: OrgIngressHandoffPolicy | null;
};

/**
 * Get org-level ingress handoff policy (raw). Returns null if none explicitly set.
 * Use getOrgIngressHandoffPolicy for the effective policy with fallback to default.
 */
async function getOrgIngressHandoffPolicyRaw(
  orgId?: string | null
): Promise<OrgIngressHandoffPolicy | null> {
  if (isDemoMode()) {
    return demoIngressHandoffPolicy;
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) {
    return null;
  }
  const { data } = await admin
    .from("orgs")
    .select("ingress_handoff_policy")
    .eq("id", orgId)
    .maybeSingle();
  const raw = (data as { ingress_handoff_policy?: unknown } | null)?.ingress_handoff_policy;
  if (!raw) {
    return null;
  }
  return normalizeIngressHandoffPolicy(raw);
}

export async function getOrgIngressHandoffPolicy(
  orgId?: string | null
): Promise<OrgIngressHandoffPolicy> {
  const raw = await getOrgIngressHandoffPolicyRaw(orgId);
  return raw ?? defaultIngressHandoffPolicy();
}

export async function setOrgIngressHandoffPolicy(
  orgId: string,
  policy: OrgIngressHandoffPolicy
): Promise<OrgIngressHandoffPolicy> {
  const next = normalizeIngressHandoffPolicy({
    ...policy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  });
  if (isDemoMode()) {
    demoIngressHandoffPolicy = next;
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { error } = await admin
    .from("orgs")
    .update({
      ingress_handoff_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
  if (error) throw new Error(error.message);
  return next;
}

export function resetDemoIngressHandoffPolicy(): void {
  demoIngressHandoffPolicy = null;
  demoEmployeeIngressHandoffPolicies.clear();
}

/**
 * Get employee-level ingress handoff policy override.
 * Returns null if no override is set (inherit org policy).
 */
export async function getEmployeeIngressHandoffPolicy(
  employeeId?: string | null
): Promise<OrgIngressHandoffPolicy | null> {
  if (!employeeId) return null;

  if (isDemoMode()) {
    return demoEmployeeIngressHandoffPolicies.get(employeeId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data } = await admin
    .from("employees")
    .select("ingress_handoff_policy")
    .eq("id", employeeId)
    .maybeSingle();

  const raw = (data as { ingress_handoff_policy?: unknown } | null)
    ?.ingress_handoff_policy;
  if (!raw) return null;

  return normalizeIngressHandoffPolicy(raw);
}

/**
 * Set or clear employee-level ingress handoff policy override.
 * Pass null to clear the override and inherit org policy.
 */
export async function setEmployeeIngressHandoffPolicy(
  employeeId: string,
  orgId: string,
  policy: OrgIngressHandoffPolicy | null
): Promise<OrgIngressHandoffPolicy | null> {
  const next = policy
    ? normalizeIngressHandoffPolicy({
        ...policy,
        updatedAt: new Date().toISOString(),
        updatedBy: "admin_mcp",
      })
    : null;

  if (isDemoMode()) {
    if (next === null) {
      demoEmployeeIngressHandoffPolicies.delete(employeeId);
    } else {
      demoEmployeeIngressHandoffPolicies.set(employeeId, next);
    }
    return next;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const { error } = await admin
    .from("employees")
    .update({
      ingress_handoff_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", employeeId)
    .eq("org_id", orgId);

  if (error) throw new Error(error.message);
  return next;
}

/**
 * Get effective ingress handoff policy with fallback order:
 * employee override → org policy → convenience default.
 *
 * @param orgId - Organization ID
 * @param employeeId - Optional employee ID for per-employee lookup
 * @returns Effective policy with source metadata
 */
export async function getEffectiveIngressHandoffPolicy(
  orgId?: string | null,
  employeeId?: string | null
): Promise<EffectiveIngressHandoffPolicy> {
  const employeeOverride = employeeId
    ? await getEmployeeIngressHandoffPolicy(employeeId)
    : null;
  const orgPolicyRaw = orgId ? await getOrgIngressHandoffPolicyRaw(orgId) : null;
  const defaultPolicy = defaultIngressHandoffPolicy();

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
