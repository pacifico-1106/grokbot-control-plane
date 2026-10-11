/**
 * Stripe webhook event ledger: dedupe by event.id with a processing claim.
 * Done is recorded only after successful processing; crashes are recovered
 * by lease expiry; transient failures leave the event retryable.
 */
import { describe, expect, test } from "bun:test";
import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
  rejectStripeWebhookEvent,
  classifySupabaseLedgerError,
  createMemoryStripeWebhookEventStore,
  WebhookLedgerUnavailableError,
  STRIPE_WEBHOOK_LEASE_MS,
} from "./stripe-webhook-ledger";

const EVT = { id: "evt_1", type: "customer.subscription.updated" };
const T0 = new Date("2026-10-03T08:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("claimStripeWebhookEvent", () => {
  test("first delivery is claimed (attempt 1, status processing)", async () => {
    const store = createMemoryStripeWebhookEventStore();
    const r = await claimStripeWebhookEvent(store, EVT, { now: T0 });
    expect(r).toEqual({ kind: "claimed", attempt: 1 });
    expect(store.rows.get("evt_1")?.status).toBe("processing");
  });

  test("not marked done before completion; done only after complete()", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    expect(store.rows.get("evt_1")?.processed_at).toBe(null);
    await completeStripeWebhookEvent(store, EVT.id, 1, { orgId: null, now: T0 });
    expect(store.rows.get("evt_1")?.status).toBe("processed");
    expect(store.rows.get("evt_1")?.processed_at).toBe(T0.toISOString());
  });

  test("duplicate after success is skipped", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    await completeStripeWebhookEvent(store, EVT.id, 1, { orgId: null, now: T0 });
    const r = await claimStripeWebhookEvent(store, EVT, { now: later(1000) });
    expect(r).toEqual({ kind: "duplicate" });
  });

  test("concurrent duplicate while processing (lease alive) → in_progress", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    const r = await claimStripeWebhookEvent(store, EVT, { now: later(1000) });
    expect(r).toEqual({ kind: "in_progress" });
  });

  test("crashed worker (stale processing lease) is taken over on retry", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    const r = await claimStripeWebhookEvent(store, EVT, {
      now: later(STRIPE_WEBHOOK_LEASE_MS + 1),
    });
    expect(r).toEqual({ kind: "claimed", attempt: 2 });
    // The crashed worker's late completion is fenced out.
    const stale = await completeStripeWebhookEvent(store, EVT.id, 1, { orgId: null });
    expect(stale).toBe(false);
    expect(store.rows.get("evt_1")?.status).toBe("processing");
  });

  test("failed (transient) event is retried by the next delivery", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    await failStripeWebhookEvent(store, EVT.id, 1, new Error("db timeout"));
    expect(store.rows.get("evt_1")?.status).toBe("failed");
    expect(store.rows.get("evt_1")?.last_error).toBe("db timeout");
    const r = await claimStripeWebhookEvent(store, EVT, { now: later(1000) });
    expect(r).toEqual({ kind: "claimed", attempt: 2 });
  });

  test("rejected (tenant mismatch) event is re-evaluated on manual resend", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    await rejectStripeWebhookEvent(store, EVT.id, 1, "customer_org_mismatch");
    expect(store.rows.get("evt_1")?.status).toBe("rejected");
    const r = await claimStripeWebhookEvent(store, EVT, { now: later(1000) });
    expect(r).toEqual({ kind: "claimed", attempt: 2 });
  });

  test("two racing takeovers: only one wins", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    await failStripeWebhookEvent(store, EVT.id, 1, new Error("x"));
    const [a, b] = await Promise.all([
      claimStripeWebhookEvent(store, EVT, { now: later(10) }),
      claimStripeWebhookEvent(store, EVT, { now: later(10) }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["claimed", "in_progress"]);
  });

  test("no store (DEMO / migration not applied) → ledger_unavailable", async () => {
    const r = await claimStripeWebhookEvent(null, EVT, { now: T0 });
    expect(r.kind).toBe("ledger_unavailable");
  });

  test("table missing error → ledger_unavailable (fail safe: processing continues as before)", async () => {
    const store = createMemoryStripeWebhookEventStore();
    store.insertProcessing = async () => {
      throw new WebhookLedgerUnavailableError("relation does not exist");
    };
    const r = await claimStripeWebhookEvent(store, EVT, { now: T0 });
    expect(r.kind).toBe("ledger_unavailable");
  });

  test("other DB errors propagate (caller returns 5xx so Stripe retries)", async () => {
    const store = createMemoryStripeWebhookEventStore();
    store.insertProcessing = async () => {
      throw new Error("connection reset");
    };
    await expect(claimStripeWebhookEvent(store, EVT, { now: T0 })).rejects.toThrow(
      "connection reset"
    );
  });

  test("org_id is only recorded when it is a uuid (FK to orgs)", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    await completeStripeWebhookEvent(store, EVT.id, 1, { orgId: "org_demo" });
    expect(store.rows.get("evt_1")?.org_id).toBe(null);
    const store2 = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store2, EVT, { now: T0 });
    const uuid = "11111111-1111-4111-8111-111111111111";
    await completeStripeWebhookEvent(store2, EVT.id, 1, { orgId: uuid });
    expect(store2.rows.get("evt_1")?.org_id).toBe(uuid);
  });

  test("last_error is truncated and never carries payloads", async () => {
    const store = createMemoryStripeWebhookEventStore();
    await claimStripeWebhookEvent(store, EVT, { now: T0 });
    await failStripeWebhookEvent(store, EVT.id, 1, new Error("x".repeat(5000)));
    expect((store.rows.get("evt_1")?.last_error || "").length).toBeLessThanOrEqual(500);
  });
});

describe("classifySupabaseLedgerError", () => {
  test("missing table codes → unavailable", () => {
    expect(classifySupabaseLedgerError({ code: "42P01", message: "x" })).toBe("unavailable");
    expect(classifySupabaseLedgerError({ code: "PGRST205", message: "x" })).toBe("unavailable");
    expect(
      classifySupabaseLedgerError({
        message: "Could not find the table 'public.stripe_webhook_events' in the schema cache",
      })
    ).toBe("unavailable");
  });
  test("unique violation → conflict", () => {
    expect(classifySupabaseLedgerError({ code: "23505", message: "dup" })).toBe("conflict");
  });
  test("anything else → error", () => {
    expect(classifySupabaseLedgerError({ code: "57014", message: "timeout" })).toBe("error");
    expect(classifySupabaseLedgerError({ message: "fetch failed" })).toBe("error");
  });
});
