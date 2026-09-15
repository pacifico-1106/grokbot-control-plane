import { getRuntimeAudit, pushRuntimeAuditEvent } from "../demo-data";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapAuditRow } from "./mappers";
import type { AuditEvent } from "../types";

const STUCK_WATCH_WAKE_ACTIONS = [
  "slack.mention_wake",
  "slack.internal_im_wake",
  "slack.user_token_im_wake",
] as const;

export async function listAuditEvents(
  orgId?: string | null,
  limit = 100
): Promise<AuditEvent[]> {
  if (isDemoMode()) {
    const events = getRuntimeAudit();
    if (!orgId) return events.slice(0, limit);
    return events.filter((event) => event.orgId === orgId).slice(0, limit);
  }
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

/** Recent audits for F7 stuck watch (wake + invoke + stuck_watch actions). */
export async function listAuditEventsForStuckWatch(
  orgId?: string | null,
  limit = 500
): Promise<AuditEvent[]> {
  if (isDemoMode()) {
    const events = getRuntimeAudit();
    const filtered = orgId
      ? events.filter((event) => event.orgId === orgId)
      : events;
    return filtered.slice(0, limit);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  let query = admin
    .from("audit_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (orgId) {
    query = query.eq("org_id", orgId);
  }
  const { data, error } = await query;
  if (error || !data) return [];
  return data.map((r) => mapAuditRow(r as Record<string, unknown>));
}

export function isMentionWakeAudit(event: AuditEvent): boolean {
  return (
    STUCK_WATCH_WAKE_ACTIONS.includes(
      event.action as (typeof STUCK_WATCH_WAKE_ACTIONS)[number]
    ) && event.metadata?.reason === "woke"
  );
}

export async function appendAuditEvent(
  event: Omit<AuditEvent, "id" | "createdAt"> & { actorEmail?: string }
): Promise<void> {
  if (isDemoMode()) {
    pushRuntimeAuditEvent({
      orgId: event.orgId,
      employeeId: event.employeeId,
      credentialId: event.credentialId,
      action: event.action,
      purpose: event.purpose,
      summary: event.summary,
      metadata: {
        ...(event.metadata ?? {}),
        ...(event.actorEmail ? { actorEmail: event.actorEmail } : {}),
      },
    });
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  const asUuid = (value: string | null | undefined) => {
    const raw = (value || "").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
      ? raw
      : null;
  };
  await admin.from("audit_events").insert({
    org_id: event.orgId,
    employee_id: asUuid(event.employeeId),
    credential_id: asUuid(event.credentialId),
    actor_email: event.actorEmail ?? null,
    action: event.action,
    purpose: event.purpose,
    summary: event.summary,
    metadata: event.metadata ?? {},
  });
}
