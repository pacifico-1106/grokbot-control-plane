/**
 * F1 mouth routing policy storage (org and employee-level).
 * Fallback order: employee override → org policy → convenience default.
 * Mirrors A1 scheduling.policy storage pattern.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import {
  defaultMouthRoutingPolicy,
  normalizeMouthRoutingPolicy,
} from "@/lib/gateway/mouth-routing-validate";
import type { OrgMouthRoutingPolicy } from "@/lib/types";

let demoMouthRoutingPolicy: OrgMouthRoutingPolicy | null = null;
const demoEmployeeMouthRoutingPolicies = new Map<string, OrgMouthRoutingPolicy | null>();

export type MouthRoutingPolicySource = "employee" | "org" | "default";

export type EffectiveMouthRoutingPolicy = {
  policy: OrgMouthRoutingPolicy;
  source: MouthRoutingPolicySource;
  employeeOverride: OrgMouthRoutingPolicy | null;
  orgPolicy: OrgMouthRoutingPolicy | null;
};

/**
 * Get org-level mouth routing policy (raw). Returns null if none explicitly set.
 */
async function getOrgMouthRoutingPolicyRaw(
  orgId?: string | null
): Promise<OrgMouthRoutingPolicy | null> {
  if (isDemoMode()) {
    return demoMouthRoutingPolicy;
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) {
    return null;
  }
  const { data } = await admin
    .from("orgs")
    .select("mouth_routing_policy")
    .eq("id", orgId)
    .maybeSingle();
  const raw = (data as { mouth_routing_policy?: unknown } | null)?.mouth_routing_policy;
  if (!raw) {
    return null;
  }
  return normalizeMouthRoutingPolicy(raw);
}

export async function getOrgMouthRoutingPolicy(
  orgId?: string | null
): Promise<OrgMouthRoutingPolicy> {
  const raw = await getOrgMouthRoutingPolicyRaw(orgId);
  return raw ?? defaultMouthRoutingPolicy();
}

export async function setOrgMouthRoutingPolicy(
  orgId: string,
  policy: OrgMouthRoutingPolicy
): Promise<OrgMouthRoutingPolicy> {
  const next = normalizeMouthRoutingPolicy({
    ...policy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  });
  if (isDemoMode()) {
    demoMouthRoutingPolicy = next;
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { error } = await admin
    .from("orgs")
    .update({
      mouth_routing_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
  if (error) throw new Error(error.message);
  return next;
}

export function resetDemoMouthRoutingPolicy(): void {
  demoMouthRoutingPolicy = null;
  demoEmployeeMouthRoutingPolicies.clear();
}

/**
 * Get employee-level mouth routing policy override.
 * Returns null if no override is set (inherit org policy).
 */
export async function getEmployeeMouthRoutingPolicy(
  employeeId?: string | null
): Promise<OrgMouthRoutingPolicy | null> {
  if (!employeeId) return null;

  if (isDemoMode()) {
    return demoEmployeeMouthRoutingPolicies.get(employeeId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data } = await admin
    .from("employees")
    .select("mouth_routing_policy")
    .eq("id", employeeId)
    .maybeSingle();

  const raw = (data as { mouth_routing_policy?: unknown } | null)?.mouth_routing_policy;
  if (!raw) return null;

  return normalizeMouthRoutingPolicy(raw);
}

/**
 * Set or clear employee-level mouth routing policy override.
 * Pass null to clear the override and inherit org policy.
 */
export async function setEmployeeMouthRoutingPolicy(
  employeeId: string,
  orgId: string,
  policy: OrgMouthRoutingPolicy | null
): Promise<OrgMouthRoutingPolicy | null> {
  const next = policy
    ? normalizeMouthRoutingPolicy({
        ...policy,
        updatedAt: new Date().toISOString(),
        updatedBy: "admin_mcp",
      })
    : null;

  if (isDemoMode()) {
    if (next === null) {
      demoEmployeeMouthRoutingPolicies.delete(employeeId);
    } else {
      demoEmployeeMouthRoutingPolicies.set(employeeId, next);
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
      mouth_routing_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", employeeId)
    .eq("org_id", orgId);

  if (error) throw new Error(error.message);
  return next;
}

/**
 * Get effective mouth routing policy with fallback order:
 * employee override → org policy → convenience default.
 */
export async function getEffectiveMouthRoutingPolicy(
  orgId?: string | null,
  employeeId?: string | null
): Promise<EffectiveMouthRoutingPolicy> {
  const employeeOverride = employeeId
    ? await getEmployeeMouthRoutingPolicy(employeeId)
    : null;
  const orgPolicyRaw = orgId ? await getOrgMouthRoutingPolicyRaw(orgId) : null;
  const defaultPolicy = defaultMouthRoutingPolicy();

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
 * Record high-risk consent for mouth routing (e.g., auto-routing without approval).
 */
export async function recordMouthRoutingHighRiskConsent(
  orgId: string,
  consentBy: string
): Promise<OrgMouthRoutingPolicy> {
  const current = await getOrgMouthRoutingPolicy(orgId);
  const next: OrgMouthRoutingPolicy = {
    ...current,
    highRiskConsentAt: new Date().toISOString(),
    highRiskConsentBy: consentBy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
  return setOrgMouthRoutingPolicy(orgId, next);
}
