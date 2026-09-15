/**
 * F7 stuck watch policy storage (org-level).
 * Null column → sensible defaults via normalizeStuckWatchPolicy.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import {
  defaultStuckWatchPolicy,
  normalizeStuckWatchPolicy,
} from "@/lib/stuck-watch/validate";
import type { OrgStuckWatchPolicy } from "@/lib/types";

let demoStuckWatchPolicy: OrgStuckWatchPolicy | null = null;

async function getOrgStuckWatchPolicyRaw(
  orgId?: string | null
): Promise<OrgStuckWatchPolicy | null> {
  if (isDemoMode()) {
    return demoStuckWatchPolicy;
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) {
    return null;
  }
  const { data } = await admin
    .from("orgs")
    .select("stuck_watch_policy")
    .eq("id", orgId)
    .maybeSingle();
  const raw = (data as { stuck_watch_policy?: unknown } | null)?.stuck_watch_policy;
  if (!raw) {
    return null;
  }
  return normalizeStuckWatchPolicy(raw);
}

export async function getOrgStuckWatchPolicy(
  orgId?: string | null
): Promise<OrgStuckWatchPolicy> {
  const raw = await getOrgStuckWatchPolicyRaw(orgId);
  return raw ?? defaultStuckWatchPolicy();
}

export async function setOrgStuckWatchPolicy(
  orgId: string,
  policy: Partial<OrgStuckWatchPolicy>,
  updatedBy = "admin_mcp"
): Promise<OrgStuckWatchPolicy> {
  const current = await getOrgStuckWatchPolicy(orgId);
  const next = normalizeStuckWatchPolicy({
    ...current,
    ...policy,
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
  });
  if (isDemoMode()) {
    demoStuckWatchPolicy = next;
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { error } = await admin
    .from("orgs")
    .update({
      stuck_watch_policy: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
  if (error) throw new Error(error.message);
  return next;
}

export function resetDemoStuckWatchPolicy(): void {
  demoStuckWatchPolicy = null;
}
