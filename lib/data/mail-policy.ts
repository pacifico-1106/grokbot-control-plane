/**
 * B1 mail policy storage (org and employee-level).
 * Fallback order: employee override → org policy → convenience default.
 * Mirrors A1 scheduling.policy / B2 reply-policy storage pattern.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import {
  defaultMailPolicy,
  normalizeMailPolicy,
} from "@/lib/mail-policy/validate";
import type { OrgMailPolicy } from "@/lib/types";

let demoMailPolicy: OrgMailPolicy | null = null;
const demoEmployeeMailPolicies = new Map<string, OrgMailPolicy | null>();

export type MailPolicySource = "employee" | "org" | "default";

export type EffectiveMailPolicy = {
  policy: OrgMailPolicy;
  source: MailPolicySource;
  employeeOverride: OrgMailPolicy | null;
  orgPolicy: OrgMailPolicy | null;
};

async function getOrgMailPolicyRaw(
  orgId?: string | null
): Promise<OrgMailPolicy | null> {
  if (isDemoMode()) {
    return demoMailPolicy;
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) {
    return null;
  }
  const { data } = await admin
    .from("orgs")
    .select("mail_policy")
    .eq("id", orgId)
    .maybeSingle();
  const raw = (data as { mail_policy?: unknown } | null)?.mail_policy;
  if (!raw) {
    return null;
  }
  return normalizeMailPolicy(raw);
}

export async function getOrgMailPolicy(
  orgId?: string | null
): Promise<OrgMailPolicy> {
  const raw = await getOrgMailPolicyRaw(orgId);
  return raw ?? defaultMailPolicy();
}

export async function setOrgMailPolicy(
  orgId: string,
  policy: OrgMailPolicy
): Promise<OrgMailPolicy> {
  const next = normalizeMailPolicy({
    ...policy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  });
  if (isDemoMode()) {
    demoMailPolicy = next;
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { error } = await admin
    .from("orgs")
    .update({
      mail_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
  if (error) throw new Error(error.message);
  return next;
}

export function resetDemoMailPolicy(): void {
  demoMailPolicy = null;
  demoEmployeeMailPolicies.clear();
}

export async function getEmployeeMailPolicy(
  employeeId?: string | null
): Promise<OrgMailPolicy | null> {
  if (!employeeId) return null;

  if (isDemoMode()) {
    return demoEmployeeMailPolicies.get(employeeId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data } = await admin
    .from("employees")
    .select("mail_policy")
    .eq("id", employeeId)
    .maybeSingle();

  const raw = (data as { mail_policy?: unknown } | null)?.mail_policy;
  if (!raw) return null;

  return normalizeMailPolicy(raw);
}

export async function setEmployeeMailPolicy(
  employeeId: string,
  orgId: string,
  policy: OrgMailPolicy | null
): Promise<OrgMailPolicy | null> {
  const next = policy
    ? normalizeMailPolicy({
        ...policy,
        updatedAt: new Date().toISOString(),
        updatedBy: "admin_mcp",
      })
    : null;

  if (isDemoMode()) {
    if (next === null) {
      demoEmployeeMailPolicies.delete(employeeId);
    } else {
      demoEmployeeMailPolicies.set(employeeId, next);
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
      mail_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", employeeId)
    .eq("org_id", orgId);

  if (error) throw new Error(error.message);
  return next;
}

export async function getEffectiveMailPolicy(
  orgId?: string | null,
  employeeId?: string | null
): Promise<EffectiveMailPolicy> {
  const employeeOverride = employeeId
    ? await getEmployeeMailPolicy(employeeId)
    : null;
  const orgPolicyRaw = orgId ? await getOrgMailPolicyRaw(orgId) : null;
  const defaultPolicy = defaultMailPolicy();

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

export async function recordMailPolicyHighRiskConsent(
  orgId: string,
  consentBy: string
): Promise<OrgMailPolicy> {
  const current = await getOrgMailPolicy(orgId);
  const next: OrgMailPolicy = {
    ...current,
    highRiskConsentAt: new Date().toISOString(),
    highRiskConsentBy: consentBy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
  return setOrgMailPolicy(orgId, next);
}
