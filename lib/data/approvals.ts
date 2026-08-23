import {
  getRuntimeApprovals,
  resolveRuntimeApproval,
} from "../demo-data";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapApprovalRow } from "./mappers";
import type { ApprovalRequest } from "../types";

export async function listApprovals(
  orgId?: string | null
): Promise<ApprovalRequest[]> {
  if (isDemoMode()) return getRuntimeApprovals();
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return [];
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data.map((r) => mapApprovalRow(r as Record<string, unknown>));
}

export async function getApprovalById(
  id: string,
  orgId?: string | null
): Promise<ApprovalRequest | null> {
  if (!id) return null;
  if (isDemoMode()) {
    return getRuntimeApprovals().find((a) => a.id === id) ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  let q = admin.from("approval_requests").select("*").eq("id", id);
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q.maybeSingle();
  if (error || !data) return null;
  return mapApprovalRow(data as Record<string, unknown>);
}

export async function resolveApproval(
  id: string,
  status: "approved" | "rejected",
  resolvedBy: string,
  orgId?: string | null
): Promise<ApprovalRequest | null> {
  if (isDemoMode()) {
    return resolveRuntimeApproval(id, status, resolvedBy);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const now = new Date().toISOString();
  let q = admin
    .from("approval_requests")
    .update({
      status,
      resolved_at: now,
      resolved_by: null,
    })
    .eq("id", id);
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q.select("*").maybeSingle();

  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  await admin.from("audit_events").insert({
    org_id: row.org_id,
    employee_id: row.employee_id,
    credential_id: row.credential_id,
    actor_email: resolvedBy,
    action: "approval.resolved",
    purpose: row.purpose,
    summary:
      status === "approved"
        ? `承認: ${row.summary}`
        : `却下: ${row.summary}`,
    metadata: { decision: status, resolvedBy },
  });

  const mapped = mapApprovalRow(row);
  mapped.resolvedBy = resolvedBy;
  return mapped;
}
