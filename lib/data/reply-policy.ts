/**
 * B2 reply policy storage (org and employee-level).
 * Fallback order: employee override → org policy → convenience default.
 * Mirrors A1 scheduling.policy / F1 mouth-routing storage pattern.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import {
  defaultReplyPolicy,
  normalizeReplyPolicy,
} from "@/lib/gateway/reply-policy-validate";
import type { OrgReplyPolicy } from "@/lib/types";

let demoReplyPolicy: OrgReplyPolicy | null = null;
const demoEmployeeReplyPolicies = new Map<string, OrgReplyPolicy | null>();

export type ReplyPolicySource = "employee" | "org" | "default";

export type EffectiveReplyPolicy = {
  policy: OrgReplyPolicy;
  source: ReplyPolicySource;
  employeeOverride: OrgReplyPolicy | null;
  orgPolicy: OrgReplyPolicy | null;
};

/**
 * Get org-level reply policy (raw). Returns null if none explicitly set.
 */
async function getOrgReplyPolicyRaw(
  orgId?: string | null
): Promise<OrgReplyPolicy | null> {
  if (isDemoMode()) {
    return demoReplyPolicy;
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) {
    return null;
  }
  const { data } = await admin
    .from("orgs")
    .select("reply_policy")
    .eq("id", orgId)
    .maybeSingle();
  const raw = (data as { reply_policy?: unknown } | null)?.reply_policy;
  if (!raw) {
    return null;
  }
  return normalizeReplyPolicy(raw);
}

export async function getOrgReplyPolicy(
  orgId?: string | null
): Promise<OrgReplyPolicy> {
  const raw = await getOrgReplyPolicyRaw(orgId);
  return raw ?? defaultReplyPolicy();
}

export async function setOrgReplyPolicy(
  orgId: string,
  policy: OrgReplyPolicy
): Promise<OrgReplyPolicy> {
  const next = normalizeReplyPolicy({
    ...policy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  });
  if (isDemoMode()) {
    demoReplyPolicy = next;
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { error } = await admin
    .from("orgs")
    .update({
      reply_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
  if (error) throw new Error(error.message);
  return next;
}

export function resetDemoReplyPolicy(): void {
  demoReplyPolicy = null;
  demoEmployeeReplyPolicies.clear();
}

/**
 * Get employee-level reply policy override.
 * Returns null if no override is set (inherit org policy).
 */
export async function getEmployeeReplyPolicy(
  employeeId?: string | null
): Promise<OrgReplyPolicy | null> {
  if (!employeeId) return null;

  if (isDemoMode()) {
    return demoEmployeeReplyPolicies.get(employeeId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data } = await admin
    .from("employees")
    .select("reply_policy")
    .eq("id", employeeId)
    .maybeSingle();

  const raw = (data as { reply_policy?: unknown } | null)?.reply_policy;
  if (!raw) return null;

  return normalizeReplyPolicy(raw);
}

/**
 * Set or clear employee-level reply policy override.
 * Pass null to clear the override and inherit org policy.
 */
export async function setEmployeeReplyPolicy(
  employeeId: string,
  orgId: string,
  policy: OrgReplyPolicy | null
): Promise<OrgReplyPolicy | null> {
  const next = policy
    ? normalizeReplyPolicy({
        ...policy,
        updatedAt: new Date().toISOString(),
        updatedBy: "admin_mcp",
      })
    : null;

  if (isDemoMode()) {
    if (next === null) {
      demoEmployeeReplyPolicies.delete(employeeId);
    } else {
      demoEmployeeReplyPolicies.set(employeeId, next);
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
      reply_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", employeeId)
    .eq("org_id", orgId);

  if (error) throw new Error(error.message);
  return next;
}

/**
 * Get effective reply policy with fallback order:
 * employee override → org policy → convenience default.
 */
export async function getEffectiveReplyPolicy(
  orgId?: string | null,
  employeeId?: string | null
): Promise<EffectiveReplyPolicy> {
  const employeeOverride = employeeId
    ? await getEmployeeReplyPolicy(employeeId)
    : null;
  const orgPolicyRaw = orgId ? await getOrgReplyPolicyRaw(orgId) : null;
  const defaultPolicy = defaultReplyPolicy();

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
 * Record high-risk consent for reply policy (e.g., after-hours auto-send).
 */
export async function recordReplyPolicyHighRiskConsent(
  orgId: string,
  consentBy: string
): Promise<OrgReplyPolicy> {
  const current = await getOrgReplyPolicy(orgId);
  const next: OrgReplyPolicy = {
    ...current,
    highRiskConsentAt: new Date().toISOString(),
    highRiskConsentBy: consentBy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
  return setOrgReplyPolicy(orgId, next);
}
