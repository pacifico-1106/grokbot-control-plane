import { getRuntimeAudit } from "../demo-data";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapAuditRow } from "./mappers";
import type { AuditEvent } from "../types";

export async function listAuditEvents(
  orgId?: string | null,
  limit = 100
): Promise<AuditEvent[]> {
  if (isDemoMode()) return getRuntimeAudit().slice(0, limit);
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return [];
  const { data, error } = await admin
    .from("audit_events")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data.map((r) => mapAuditRow(r as Record<string, unknown>));
}

export async function appendAuditEvent(
  event: Omit<AuditEvent, "id" | "createdAt"> & { actorEmail?: string }
): Promise<void> {
  if (isDemoMode()) {
    const { getRuntimeAudit } = await import("../demo-data");
    // demo-data mutators already append; this is a no-op path for prod parity
    void getRuntimeAudit;
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin.from("audit_events").insert({
    org_id: event.orgId,
    employee_id: event.employeeId,
    credential_id: event.credentialId,
    actor_email: event.actorEmail ?? null,
    action: event.action,
    purpose: event.purpose,
    summary: event.summary,
    metadata: event.metadata ?? {},
  });
}
