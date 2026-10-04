/**
 * Persistence for MCP Events subscriptions + delivery outbox.
 * Demo: in-memory. Production: service-role only tables from
 * supabase/migrations/20261005000000_mcp_event_subscriptions.sql (RLS on,
 * no policy). Every query that selects for delivery filters on BOTH org_id
 * and employee_id (tenant isolation); the schema enforces the same pairing.
 * Secrets are only ever stored as ciphertext (lib/notify/crypto.ts).
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { McpEventName, EventArguments } from "./catalog";
import type { DeliveryErrorCategory } from "./transport";
import type { RiskReason, SubscriptionRisk } from "./policy";

export type SubscriptionStatus = "active" | "unsubscribed" | "revoked" | "expired";
export type SubscriptionRow = {
  id: string;
  orgId: string;
  employeeId: string;
  credentialId: string | null;
  credentialGeneration: number;
  credentialFingerprint: string;
  principal: string;
  eventName: McpEventName;
  arguments: EventArguments;
  deliveryUrl: string;
  deliveryHost: string;
  secretCiphertext: string;
  secretFingerprint: string;
  previousSecretCiphertext: string | null;
  previousSecretValidUntil: string | null;
  status: SubscriptionStatus;
  risk: SubscriptionRisk;
  riskReasons: RiskReason[];
  grantedTtlMs: number;
  refreshBefore: string;
  verifiedAt: string | null;
  lastDeliveryAt: string | null;
  lastError: DeliveryErrorCategory | null;
  failedSince: string | null;
  revokedReason: string | null;
  createdAt: string;
  updatedAt: string;
};
export type DeliveryStatus = "pending" | "delivered" | "abandoned" | "dropped";
export type DeliveryRow = {
  id: string;
  orgId: string;
  employeeId: string;
  subscriptionId: string;
  eventId: string;
  eventName: McpEventName;
  approvalId: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  lastStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  attributedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const demoSubs = new Map<string, SubscriptionRow>();
const demoDeliveries = new Map<string, DeliveryRow>();
const verificationsByHost = new Map<string, number[]>();

export function __resetMcpEventsStoreForTests(): void {
  demoSubs.clear();
  demoDeliveries.clear();
  verificationsByHost.clear();
}

/** Per-host verification POST budget (in-memory, per instance; anti-flooding). */
export function takeVerificationBudget(host: string, nowMs: number, perMinute: number): boolean {
  const recent = (verificationsByHost.get(host) || []).filter((t) => nowMs - t < 60_000);
  if (recent.length >= perMinute) {
    verificationsByHost.set(host, recent);
    return false;
  }
  recent.push(nowMs);
  verificationsByHost.set(host, recent);
  if (verificationsByHost.size > 5000) verificationsByHost.delete(verificationsByHost.keys().next().value as string);
  return true;
}

// ---- mapping -------------------------------------------------------------
function subToDb(r: SubscriptionRow): Record<string, unknown> {
  return {
    id: r.id, org_id: r.orgId, employee_id: r.employeeId, credential_id: r.credentialId,
    credential_generation: r.credentialGeneration, credential_fingerprint: r.credentialFingerprint, principal: r.principal,
    event_name: r.eventName, arguments: r.arguments, delivery_url: r.deliveryUrl, delivery_host: r.deliveryHost,
    secret_ciphertext: r.secretCiphertext, secret_fingerprint: r.secretFingerprint,
    previous_secret_ciphertext: r.previousSecretCiphertext, previous_secret_valid_until: r.previousSecretValidUntil,
    status: r.status, risk: r.risk, risk_reasons: r.riskReasons, granted_ttl_ms: r.grantedTtlMs,
    refresh_before: r.refreshBefore, verified_at: r.verifiedAt, last_delivery_at: r.lastDeliveryAt,
    last_error: r.lastError, failed_since: r.failedSince, revoked_reason: r.revokedReason,
    created_at: r.createdAt, updated_at: r.updatedAt,
  };
}
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
function subFromDb(d: Record<string, unknown>): SubscriptionRow {
  return {
    id: String(d.id), orgId: String(d.org_id), employeeId: String(d.employee_id), credentialId: str(d.credential_id),
    credentialGeneration: Number(d.credential_generation), credentialFingerprint: String(d.credential_fingerprint),
    principal: String(d.principal), eventName: d.event_name as McpEventName,
    arguments: (d.arguments && typeof d.arguments === "object" ? d.arguments : {}) as EventArguments,
    deliveryUrl: String(d.delivery_url), deliveryHost: String(d.delivery_host),
    secretCiphertext: String(d.secret_ciphertext), secretFingerprint: String(d.secret_fingerprint),
    previousSecretCiphertext: str(d.previous_secret_ciphertext), previousSecretValidUntil: str(d.previous_secret_valid_until),
    status: d.status as SubscriptionStatus, risk: d.risk as SubscriptionRisk,
    riskReasons: (Array.isArray(d.risk_reasons) ? d.risk_reasons : []) as RiskReason[],
    grantedTtlMs: Number(d.granted_ttl_ms), refreshBefore: String(d.refresh_before), verifiedAt: str(d.verified_at),
    lastDeliveryAt: str(d.last_delivery_at), lastError: (d.last_error as DeliveryErrorCategory) ?? null,
    failedSince: str(d.failed_since), revokedReason: str(d.revoked_reason),
    createdAt: String(d.created_at), updatedAt: String(d.updated_at),
  };
}
function delToDb(r: Partial<DeliveryRow>): Record<string, unknown> {
  const map: Record<string, string> = {
    id: "id", orgId: "org_id", employeeId: "employee_id", subscriptionId: "subscription_id", eventId: "event_id",
    eventName: "event_name", approvalId: "approval_id", body: "body", status: "status", attempts: "attempts",
    nextAttemptAt: "next_attempt_at", leaseUntil: "lease_until", lastStatus: "last_status", lastError: "last_error",
    deliveredAt: "delivered_at", attributedAt: "attributed_at", createdAt: "created_at", updatedAt: "updated_at",
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (map[k] && v !== undefined) out[map[k]] = v;
  return out;
}
function delFromDb(d: Record<string, unknown>): DeliveryRow {
  return {
    id: String(d.id), orgId: String(d.org_id), employeeId: String(d.employee_id), subscriptionId: String(d.subscription_id),
    eventId: String(d.event_id), eventName: d.event_name as McpEventName, approvalId: String(d.approval_id),
    body: String(d.body), status: d.status as DeliveryStatus, attempts: Number(d.attempts),
    nextAttemptAt: str(d.next_attempt_at), leaseUntil: str(d.lease_until),
    lastStatus: d.last_status === null || d.last_status === undefined ? null : Number(d.last_status),
    lastError: str(d.last_error), deliveredAt: str(d.delivered_at), attributedAt: str(d.attributed_at),
    createdAt: String(d.created_at), updatedAt: String(d.updated_at),
  };
}
function subPatchToDb(p: Partial<SubscriptionRow>): Record<string, unknown> {
  const full = subToDb({ ...(p as SubscriptionRow) });
  return Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined));
}
function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("mcp_events_store_unavailable");
  return client;
}
const t = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

// ---- subscriptions -------------------------------------------------------
export async function getEventSubscription(id: string): Promise<SubscriptionRow | null> {
  if (isDemoMode()) return demoSubs.has(id) ? { ...demoSubs.get(id)! } : null;
  const { data, error } = await admin().from("mcp_event_subscriptions").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error("mcp_events_store_error");
  return data ? subFromDb(data as Record<string, unknown>) : null;
}

export async function upsertEventSubscription(row: SubscriptionRow): Promise<void> {
  if (isDemoMode()) { demoSubs.set(row.id, { ...row }); return; }
  const { error } = await admin().from("mcp_event_subscriptions").upsert(subToDb(row), { onConflict: "id" });
  if (error) throw new Error("mcp_events_store_error");
}

export async function updateEventSubscription(id: string, patch: Partial<SubscriptionRow>): Promise<void> {
  if (isDemoMode()) {
    const cur = demoSubs.get(id);
    if (cur) demoSubs.set(id, { ...cur, ...patch });
    return;
  }
  const { error } = await admin().from("mcp_event_subscriptions").update(subPatchToDb(patch)).eq("id", id);
  if (error) throw new Error("mcp_events_store_error");
}

export async function countActiveEventSubscriptions(orgId: string, employeeId: string, nowIso: string): Promise<number> {
  if (isDemoMode()) {
    return [...demoSubs.values()].filter((s) => s.orgId === orgId && s.employeeId === employeeId && s.status === "active" && t(s.refreshBefore) > t(nowIso)).length;
  }
  const { count, error } = await admin().from("mcp_event_subscriptions").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("employee_id", employeeId).eq("status", "active").gt("refresh_before", nowIso);
  if (error) throw new Error("mcp_events_store_error");
  return count ?? 0;
}

/** Active, verified, unexpired subscriptions of exactly this org + employee + event. */
export async function listDeliverableEventSubscriptions(orgId: string, employeeId: string, eventName: McpEventName, nowIso: string): Promise<SubscriptionRow[]> {
  if (isDemoMode()) {
    return [...demoSubs.values()]
      .filter((s) => s.orgId === orgId && s.employeeId === employeeId && s.eventName === eventName && s.status === "active" && s.verifiedAt && t(s.refreshBefore) > t(nowIso))
      .map((s) => ({ ...s }));
  }
  const { data, error } = await admin().from("mcp_event_subscriptions").select("*")
    .eq("org_id", orgId).eq("employee_id", employeeId).eq("event_name", eventName).eq("status", "active")
    .not("verified_at", "is", null).gt("refresh_before", nowIso).limit(100);
  if (error) throw new Error("mcp_events_store_error");
  return (data || []).map((d) => subFromDb(d as Record<string, unknown>));
}

/** Verification is cached per (principal, url): any row of that pair verified since `sinceIso`. */
export async function isVerifiedFor(principal: string, url: string, sinceIso: string): Promise<boolean> {
  if (isDemoMode()) {
    return [...demoSubs.values()].some((s) => s.principal === principal && s.deliveryUrl === url && s.verifiedAt && t(s.verifiedAt) >= t(sinceIso) && s.status !== "revoked");
  }
  const { data, error } = await admin().from("mcp_event_subscriptions").select("id")
    .eq("principal", principal).eq("delivery_url", url).neq("status", "revoked").gte("verified_at", sinceIso).limit(1);
  if (error) throw new Error("mcp_events_store_error");
  return Boolean(data && data.length);
}

export async function listEventSubscriptionsForOrg(orgId: string): Promise<SubscriptionRow[]> {
  if (isDemoMode()) return [...demoSubs.values()].filter((s) => s.orgId === orgId).map((s) => ({ ...s }));
  const { data, error } = await admin().from("mcp_event_subscriptions").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error("mcp_events_store_error");
  return (data || []).map((d) => subFromDb(d as Record<string, unknown>));
}

export async function markRevokedForEmployee(orgId: string, employeeId: string, reason: string, nowIso: string): Promise<string[]> {
  const ids: string[] = [];
  if (isDemoMode()) {
    for (const s of demoSubs.values()) {
      if (s.orgId === orgId && s.employeeId === employeeId && s.status === "active") {
        demoSubs.set(s.id, { ...s, status: "revoked", revokedReason: reason, updatedAt: nowIso });
        ids.push(s.id);
      }
    }
    return ids;
  }
  const { data, error } = await admin().from("mcp_event_subscriptions")
    .update({ status: "revoked", revoked_reason: reason, updated_at: nowIso })
    .eq("org_id", orgId).eq("employee_id", employeeId).eq("status", "active").select("id");
  if (error) throw new Error("mcp_events_store_error");
  return (data || []).map((d) => String((d as { id: string }).id));
}

// ---- deliveries ----------------------------------------------------------
/** Insert once per (subscription, event); false when it already exists. */
export async function enqueueDelivery(row: DeliveryRow): Promise<boolean> {
  if (isDemoMode()) {
    if ([...demoDeliveries.values()].some((d) => d.subscriptionId === row.subscriptionId && d.eventId === row.eventId)) return false;
    demoDeliveries.set(row.id, { ...row });
    return true;
  }
  const db = delToDb(row);
  delete db.id;
  const { data, error } = await admin().from("mcp_event_deliveries")
    .upsert(db, { onConflict: "subscription_id,event_id", ignoreDuplicates: true }).select("id");
  if (error) throw new Error("mcp_events_store_error");
  if (data && data.length) { row.id = String((data[0] as { id: string }).id); return true; }
  return false;
}

/**
 * Lease a pending, due delivery for one attempt AND count that attempt
 * (attempts + 1) in the same compare-and-set. Counting at claim time means a
 * worker that dies after claiming (timeout, crash, lost update) still used up
 * the attempt, so a delivery can never be retried forever. An attempt that is
 * deferred BEFORE anything is sent (revocation check unavailable) is handed
 * back with `releaseDeferredDelivery`, which restores the count.
 * Concurrency: the update matches the attempts value that was read, so of two
 * concurrent claimers exactly one wins (cron and inline never send the same
 * attempt twice).
 */
export async function claimDelivery(id: string, nowIso: string, leaseUntilIso: string): Promise<DeliveryRow | null> {
  if (isDemoMode()) {
    const d = demoDeliveries.get(id);
    if (!d || d.status !== "pending") return null;
    if (d.nextAttemptAt && t(d.nextAttemptAt) > t(nowIso)) return null;
    if (d.leaseUntil && t(d.leaseUntil) > t(nowIso)) return null;
    const leased = { ...d, attempts: d.attempts + 1, leaseUntil: leaseUntilIso, updatedAt: nowIso };
    demoDeliveries.set(id, leased);
    return { ...leased };
  }
  const db = admin();
  const { data: cur, error: readError } = await db.from("mcp_event_deliveries").select("*")
    .eq("id", id).eq("status", "pending").lte("next_attempt_at", nowIso)
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .maybeSingle();
  if (readError) throw new Error("mcp_events_store_error");
  if (!cur) return null;
  const read = delFromDb(cur as Record<string, unknown>);
  let q = db.from("mcp_event_deliveries")
    .update({ attempts: read.attempts + 1, lease_until: leaseUntilIso, updated_at: nowIso })
    .eq("id", id).eq("status", "pending").eq("attempts", read.attempts);
  q = read.leaseUntil === null ? q.is("lease_until", null) : q.eq("lease_until", read.leaseUntil);
  const { data, error } = await q.select("*");
  if (error) throw new Error("mcp_events_store_error");
  return data && data.length ? delFromDb(data[0] as Record<string, unknown>) : null;
}

/**
 * Hand back a claimed attempt that was deferred before anything was sent:
 * the attempt count is restored (the deferral is not a delivery attempt), the
 * lease is released and the row is due again at `nextAttemptAt`.
 */
export async function releaseDeferredDelivery(id: string, claimedAttempts: number, patch: { nextAttemptAt: string; lastError: string; updatedAt: string }): Promise<void> {
  const restored = Math.max(0, claimedAttempts - 1);
  if (isDemoMode()) {
    const cur = demoDeliveries.get(id);
    if (cur && cur.status === "pending" && cur.attempts === claimedAttempts) {
      demoDeliveries.set(id, { ...cur, attempts: restored, leaseUntil: null, nextAttemptAt: patch.nextAttemptAt, lastError: patch.lastError, updatedAt: patch.updatedAt });
    }
    return;
  }
  const { error } = await admin().from("mcp_event_deliveries")
    .update({ attempts: restored, lease_until: null, next_attempt_at: patch.nextAttemptAt, last_error: patch.lastError, updated_at: patch.updatedAt })
    .eq("id", id).eq("status", "pending").eq("attempts", claimedAttempts);
  if (error) throw new Error("mcp_events_store_error");
}

export async function updateDelivery(id: string, patch: Partial<DeliveryRow>): Promise<void> {
  if (isDemoMode()) {
    const cur = demoDeliveries.get(id);
    if (cur) demoDeliveries.set(id, { ...cur, ...patch });
    return;
  }
  const { error } = await admin().from("mcp_event_deliveries").update(delToDb(patch)).eq("id", id);
  if (error) throw new Error("mcp_events_store_error");
}

export async function listDueDeliveryIds(nowIso: string, limit: number): Promise<string[]> {
  if (isDemoMode()) {
    return [...demoDeliveries.values()]
      .filter((d) => d.status === "pending" && (!d.nextAttemptAt || t(d.nextAttemptAt) <= t(nowIso)))
      .sort((a, b) => t(a.nextAttemptAt) - t(b.nextAttemptAt))
      .slice(0, limit)
      .map((d) => d.id);
  }
  const { data, error } = await admin().from("mcp_event_deliveries").select("id")
    .eq("status", "pending").lte("next_attempt_at", nowIso).order("next_attempt_at", { ascending: true }).limit(limit);
  if (error) throw new Error("mcp_events_store_error");
  return (data || []).map((d) => String((d as { id: string }).id));
}

export async function dropPendingDeliveries(subscriptionIds: string[], reason: string, nowIso: string): Promise<number> {
  if (!subscriptionIds.length) return 0;
  if (isDemoMode()) {
    let n = 0;
    for (const d of demoDeliveries.values()) {
      if (subscriptionIds.includes(d.subscriptionId) && d.status === "pending") {
        demoDeliveries.set(d.id, { ...d, status: "dropped", lastError: reason, leaseUntil: null, updatedAt: nowIso });
        n++;
      }
    }
    return n;
  }
  const { data, error } = await admin().from("mcp_event_deliveries")
    .update({ status: "dropped", last_error: reason, lease_until: null, updated_at: nowIso })
    .in("subscription_id", subscriptionIds).eq("status", "pending").select("id");
  if (error) throw new Error("mcp_events_store_error");
  return (data || []).length;
}

/** Most recent delivered-but-unattributed delivery of this org + employee since `sinceIso`. */
export async function findAttributableDelivery(orgId: string, employeeId: string, sinceIso: string): Promise<DeliveryRow | null> {
  if (isDemoMode()) {
    const rows = [...demoDeliveries.values()]
      .filter((d) => d.orgId === orgId && d.employeeId === employeeId && d.status === "delivered" && !d.attributedAt && d.deliveredAt && t(d.deliveredAt) >= t(sinceIso))
      .sort((a, b) => t(b.deliveredAt) - t(a.deliveredAt));
    return rows[0] ? { ...rows[0] } : null;
  }
  const { data, error } = await admin().from("mcp_event_deliveries").select("*")
    .eq("org_id", orgId).eq("employee_id", employeeId).eq("status", "delivered").is("attributed_at", null)
    .gte("delivered_at", sinceIso).order("delivered_at", { ascending: false }).limit(1);
  if (error) throw new Error("mcp_events_store_error");
  return data && data.length ? delFromDb(data[0] as Record<string, unknown>) : null;
}

/** Conditional: true only for the first caller (attribution happens once per delivery). */
export async function markAttributed(id: string, nowIso: string): Promise<boolean> {
  if (isDemoMode()) {
    const d = demoDeliveries.get(id);
    if (!d || d.attributedAt) return false;
    demoDeliveries.set(id, { ...d, attributedAt: nowIso });
    return true;
  }
  const { data, error } = await admin().from("mcp_event_deliveries").update({ attributed_at: nowIso })
    .eq("id", id).is("attributed_at", null).select("id");
  if (error) throw new Error("mcp_events_store_error");
  return Boolean(data && data.length);
}

/** Test helper (demo store only). */
export function __listDeliveriesForTests(): DeliveryRow[] {
  return [...demoDeliveries.values()].map((d) => ({ ...d })).sort((a, b) => t(a.createdAt) - t(b.createdAt));
}

export const FINISHED_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["delivered", "abandoned", "dropped"];

/**
 * Retention: delete finished (delivered / abandoned / dropped) delivery rows
 * last updated before `cutoffIso`, at most `limit` per call. Pending rows are
 * never deleted. The audit log (mcp_events.*) keeps the long-term record.
 */
export async function deleteFinishedDeliveriesBefore(cutoffIso: string, limit: number): Promise<number> {
  if (isDemoMode()) {
    let n = 0;
    for (const d of [...demoDeliveries.values()]) {
      if (n >= limit) break;
      if (FINISHED_DELIVERY_STATUSES.includes(d.status) && t(d.updatedAt) < t(cutoffIso)) { demoDeliveries.delete(d.id); n++; }
    }
    return n;
  }
  const db = admin();
  const { data, error } = await db.from("mcp_event_deliveries").select("id")
    .in("status", [...FINISHED_DELIVERY_STATUSES]).lt("updated_at", cutoffIso).order("updated_at", { ascending: true }).limit(limit);
  if (error) throw new Error("mcp_events_store_error");
  const ids = (data || []).map((d) => String((d as { id: string }).id));
  if (!ids.length) return 0;
  const { data: deleted, error: delError } = await db.from("mcp_event_deliveries").delete()
    .in("id", ids).in("status", [...FINISHED_DELIVERY_STATUSES]).lt("updated_at", cutoffIso).select("id");
  if (delError) throw new Error("mcp_events_store_error");
  return (deleted || []).length;
}
