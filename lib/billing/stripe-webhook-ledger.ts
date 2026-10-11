/**
 * Stripe webhook event ledger (dedupe by event.id with a processing claim).
 *
 * Table: public.stripe_webhook_events
 *   (supabase/migrations/20261003200000_stripe_webhook_events.sql — NOT applied
 *   automatically; see PR for the production SQL step.)
 *
 * State machine per event_id:
 *   (none) --claim--> processing --complete--> processed   (duplicates → 2xx skip)
 *                         |  --fail------> failed          (next delivery re-claims)
 *                         |  --reject----> rejected        (permanent; manual resend re-evaluates)
 *                         `- lease expired (crash) → next delivery re-claims
 *
 * Every transition after the claim is fenced by `attempts`, so a crashed /
 * slow worker cannot overwrite the result of the worker that took over.
 *
 * Fail-safe when the migration is not applied yet (table missing) or in DEMO:
 * claim returns `ledger_unavailable` and the webhook processes the event the
 * same way it did before this ledger existed (no dedupe), while still
 * returning 5xx on transient failure. Any other DB error is thrown so the
 * webhook answers 5xx and Stripe retries.
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export const STRIPE_WEBHOOK_EVENTS_TABLE = "stripe_webhook_events";

/** Longer than any webhook function run (Vercel max duration). */
export const STRIPE_WEBHOOK_LEASE_MS = 15 * 60 * 1000;

const MAX_ERROR_LEN = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WebhookEventStatus = "processing" | "processed" | "failed" | "rejected";

export interface WebhookEventRow {
  event_id: string;
  event_type: string;
  status: WebhookEventStatus;
  attempts: number;
  claimed_at: string;
  processed_at: string | null;
  last_error: string | null;
  org_id: string | null;
}

export class WebhookLedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookLedgerUnavailableError";
  }
}

export interface StripeWebhookEventStore {
  /** Insert a new processing row. "conflict" when event_id already exists. */
  insertProcessing(row: WebhookEventRow): Promise<"inserted" | "conflict">;
  get(eventId: string): Promise<WebhookEventRow | null>;
  /** Compare-and-set on (status, attempts). true when this caller won. */
  takeover(
    eventId: string,
    expected: { status: WebhookEventStatus; attempts: number },
    patch: Partial<WebhookEventRow>
  ): Promise<boolean>;
  /** Finish a processing row owned by `attempt`. true when updated. */
  finish(
    eventId: string,
    attempt: number,
    patch: Partial<WebhookEventRow>
  ): Promise<boolean>;
}

export type ClaimResult =
  | { kind: "claimed"; attempt: number }
  | { kind: "duplicate" }
  | { kind: "in_progress" }
  | { kind: "ledger_unavailable"; reason: string };

function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "unknown_error";
  return msg.slice(0, MAX_ERROR_LEN);
}

export async function claimStripeWebhookEvent(
  store: StripeWebhookEventStore | null,
  event: { id: string; type: string },
  opts: { now?: Date; leaseMs?: number } = {}
): Promise<ClaimResult> {
  if (!store) return { kind: "ledger_unavailable", reason: "no_store" };
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? STRIPE_WEBHOOK_LEASE_MS;
  const nowIso = now.toISOString();

  let inserted: "inserted" | "conflict";
  try {
    inserted = await store.insertProcessing({
      event_id: event.id,
      event_type: event.type,
      status: "processing",
      attempts: 1,
      claimed_at: nowIso,
      processed_at: null,
      last_error: null,
      org_id: null,
    });
  } catch (e) {
    if (e instanceof WebhookLedgerUnavailableError) {
      return { kind: "ledger_unavailable", reason: e.message };
    }
    throw e;
  }
  if (inserted === "inserted") return { kind: "claimed", attempt: 1 };

  const row = await store.get(event.id);
  if (!row) return { kind: "in_progress" };
  if (row.status === "processed") return { kind: "duplicate" };

  if (row.status === "processing") {
    const claimedAt = Date.parse(row.claimed_at);
    const alive = Number.isFinite(claimedAt) && now.getTime() - claimedAt <= leaseMs;
    if (alive) return { kind: "in_progress" };
  }

  // failed / rejected / stale processing → try to take over (CAS on attempts).
  const nextAttempt = row.attempts + 1;
  const won = await store.takeover(
    event.id,
    { status: row.status, attempts: row.attempts },
    { status: "processing", attempts: nextAttempt, claimed_at: nowIso }
  );
  return won ? { kind: "claimed", attempt: nextAttempt } : { kind: "in_progress" };
}

export async function completeStripeWebhookEvent(
  store: StripeWebhookEventStore | null,
  eventId: string,
  attempt: number,
  opts: { orgId: string | null; now?: Date }
): Promise<boolean> {
  if (!store) return false;
  return store.finish(eventId, attempt, {
    status: "processed",
    processed_at: (opts.now ?? new Date()).toISOString(),
    last_error: null,
    // org_id is a FK to orgs(id); only record real (uuid) org ids.
    org_id: opts.orgId && UUID_RE.test(opts.orgId) ? opts.orgId : null,
  });
}

export async function failStripeWebhookEvent(
  store: StripeWebhookEventStore | null,
  eventId: string,
  attempt: number,
  error: unknown
): Promise<boolean> {
  if (!store) return false;
  return store.finish(eventId, attempt, {
    status: "failed",
    last_error: safeError(error),
  });
}

export async function rejectStripeWebhookEvent(
  store: StripeWebhookEventStore | null,
  eventId: string,
  attempt: number,
  reason: string
): Promise<boolean> {
  if (!store) return false;
  return store.finish(eventId, attempt, {
    status: "rejected",
    last_error: safeError(reason),
  });
}

// ---------------------------------------------------------------------------
// Supabase store
// ---------------------------------------------------------------------------

type PgError = { code?: string | null; message?: string | null };

export function classifySupabaseLedgerError(
  error: PgError
): "unavailable" | "conflict" | "error" {
  const code = String(error.code || "");
  const msg = String(error.message || "").toLowerCase();
  if (code === "23505") return "conflict";
  if (
    code === "42P01" ||
    code === "PGRST205" ||
    (msg.includes(STRIPE_WEBHOOK_EVENTS_TABLE) &&
      (msg.includes("does not exist") || msg.includes("schema cache"))) ||
    msg.includes("could not find the table")
  ) {
    return "unavailable";
  }
  return "error";
}

function raise(error: PgError, op: string): never {
  const kind = classifySupabaseLedgerError(error);
  const message = `stripe_webhook_ledger_${op}_failed: ${error.message || error.code || "unknown"}`;
  if (kind === "unavailable") throw new WebhookLedgerUnavailableError(message);
  throw new Error(message);
}

/** null in DEMO / without admin client (→ ledger_unavailable). */
export function createSupabaseStripeWebhookEventStore(): StripeWebhookEventStore | null {
  if (isDemoMode()) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const table = () => admin.from(STRIPE_WEBHOOK_EVENTS_TABLE);

  return {
    async insertProcessing(row) {
      const { error } = await table().insert(row).select("event_id");
      if (!error) return "inserted";
      if (classifySupabaseLedgerError(error) === "conflict") return "conflict";
      raise(error, "insert");
    },
    async get(eventId) {
      const { data, error } = await table()
        .select("event_id,event_type,status,attempts,claimed_at,processed_at,last_error,org_id")
        .eq("event_id", eventId)
        .maybeSingle();
      if (error) raise(error, "get");
      return (data as WebhookEventRow | null) ?? null;
    },
    async takeover(eventId, expected, patch) {
      const { data, error } = await table()
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("event_id", eventId)
        .eq("status", expected.status)
        .eq("attempts", expected.attempts)
        .select("event_id");
      if (error) raise(error, "takeover");
      return Array.isArray(data) && data.length > 0;
    },
    async finish(eventId, attempt, patch) {
      const { data, error } = await table()
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("event_id", eventId)
        .eq("status", "processing")
        .eq("attempts", attempt)
        .select("event_id");
      if (error) raise(error, "finish");
      return Array.isArray(data) && data.length > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory store (tests / reference semantics)
// ---------------------------------------------------------------------------

export function createMemoryStripeWebhookEventStore(): StripeWebhookEventStore & {
  rows: Map<string, WebhookEventRow>;
} {
  const rows = new Map<string, WebhookEventRow>();
  return {
    rows,
    async insertProcessing(row) {
      if (rows.has(row.event_id)) return "conflict";
      rows.set(row.event_id, { ...row });
      return "inserted";
    },
    async get(eventId) {
      const row = rows.get(eventId);
      return row ? { ...row } : null;
    },
    async takeover(eventId, expected, patch) {
      const row = rows.get(eventId);
      if (!row || row.status !== expected.status || row.attempts !== expected.attempts) {
        return false;
      }
      rows.set(eventId, { ...row, ...patch });
      return true;
    },
    async finish(eventId, attempt, patch) {
      const row = rows.get(eventId);
      if (!row || row.status !== "processing" || row.attempts !== attempt) return false;
      rows.set(eventId, { ...row, ...patch });
      return true;
    },
  };
}
