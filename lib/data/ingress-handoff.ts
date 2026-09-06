/**
 * Org ingress handoff policy storage (org-scoped JSON column).
 * Demo mode uses in-memory store; production uses Supabase orgs table.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import {
  defaultIngressHandoffPolicy,
  normalizeIngressHandoffPolicy,
} from "@/lib/ingress-handoff/validate";
import type { OrgIngressHandoffPolicy } from "@/lib/types";

let demoIngressHandoffPolicy: OrgIngressHandoffPolicy | null = null;

export async function getOrgIngressHandoffPolicy(
  orgId?: string | null
): Promise<OrgIngressHandoffPolicy> {
  if (isDemoMode()) {
    if (!demoIngressHandoffPolicy) {
      demoIngressHandoffPolicy = defaultIngressHandoffPolicy();
    }
    return normalizeIngressHandoffPolicy(demoIngressHandoffPolicy);
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) {
    return defaultIngressHandoffPolicy();
  }
  const { data } = await admin
    .from("orgs")
    .select("ingress_handoff_policy")
    .eq("id", orgId)
    .maybeSingle();
  const raw = (data as { ingress_handoff_policy?: unknown } | null)?.ingress_handoff_policy;
  if (!raw) {
    return defaultIngressHandoffPolicy();
  }
  return normalizeIngressHandoffPolicy(raw);
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
}
