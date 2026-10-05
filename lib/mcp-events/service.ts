/**
 * MCP Events service (flag MCP_EVENTS_ENABLED, default OFF).
 *
 * events/list | events/subscribe | events/unsubscribe for the employee badge,
 * emit of approval.decided / approval.expired from the shared approval hooks,
 * and the delivery worker (inline first attempt + cron retries).
 *
 * Invariants:
 * - Tenant isolation: a subscription is keyed by the badge principal and
 *   matched only by (org_id, employee_id, event); deliveries re-check both.
 * - Endpoint verification (signed challenge) before any delivery; cached per
 *   (principal, url) for 24 h; verification POSTs are rate-limited per host
 *   (30 / fixed minute, shared across instances via the DB; fail closed).
 * - Deliveries: one event per request, ids + status only, Standard Webhooks
 *   signature with the receiver's secret (encrypted at rest), webhook-id =
 *   eventId (stable across retries), fresh timestamp/signature per attempt,
 *   bounded retries (4 attempts / 15 min), 410 / 413 / 3xx never retried.
 * - The badge is re-checked on every attempt; on a POSITIVELY KNOWN
 *   revocation every subscription of that employee is revoked (sticky:
 *   refresh → -32012) and pending deliveries are dropped. ChatGPT has no
 *   `terminated`, so this is the stop. A check that cannot run (read error)
 *   defers the attempt instead (not counted, nothing revoked).
 * - Error responses and lastError are fixed categories, never raw receiver text.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { appendAuditEvent } from "@/lib/data/audit";
import { getApprovalById } from "@/lib/data/approvals";
import { isMcpEventsEnabled } from "@/lib/feature-flags";
import { decryptNotificationSecrets, encryptNotificationSecrets } from "@/lib/notify/crypto";
import type { ApprovalRequest, AuditAction } from "@/lib/types";
import {
  DECIDED_STATUSES,
  isMcpEventName,
  listEventDefinitions,
  matchesArguments,
  validateEventArguments,
  type McpEventName,
} from "./catalog";
import { approvalEventId, subscriptionId } from "./ids";
import { buildApprovalEventData, buildEventBody, eventStatus, type ExpiredReason } from "./payload";
import { MCP_EVENTS_LIMITS as L, classifySubscriptionRisk, grantSubscriptionTtl } from "./policy";
import { checkSubscriptionPrincipal, principalFor } from "./principal";
import { parseWhsecSecret, signStandardWebhook } from "./standard-webhooks";
import * as store from "./store";
import { defaultWebhookTransport, postWebhook, validateCallbackUrl, type WebhookTransport } from "./transport";

export type McpEventsRpcResult =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string; data?: Record<string, unknown> };

// ---- test seams ----------------------------------------------------------
let transportOverride: WebhookTransport | null = null;
let clockOverride: (() => number) | null = null;
const background = new Set<Promise<unknown>>();
export function __setMcpEventsTransportForTests(t: WebhookTransport | null): void { transportOverride = t; }
export function __setMcpEventsClockForTests(c: (() => number) | null): void { clockOverride = c; }
export async function __flushMcpEventsBackgroundForTests(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}
const nowMs = () => (clockOverride ? clockOverride() : Date.now());
const iso = (ms: number) => new Date(ms).toISOString();
const transport = () => transportOverride ?? defaultWebhookTransport();
function runInBackground(p: Promise<unknown>): void {
  const tracked: Promise<unknown> = p.catch(() => undefined).finally(() => background.delete(tracked));
  background.add(tracked);
  try { waitUntil(tracked); } catch { /* outside a Vercel request: the promise still runs */ }
}

const err = (code: number, message: string, data?: Record<string, unknown>): McpEventsRpcResult => ({ ok: false, code, message, ...(data ? { data } : {}) });
const disabled = () => err(-32601, "Method not found");
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

async function audit(input: { orgId: string; employeeId: string | null; action: AuditAction; summary: string; metadata: Record<string, unknown> }) {
  await appendAuditEvent({ ...input, credentialId: null, purpose: "mcp_events" }).catch(() => undefined);
}

// ---- events/list ---------------------------------------------------------
export async function handleEventsList(cred: ResolvedEmployeeCredential): Promise<McpEventsRpcResult> {
  if (!isMcpEventsEnabled()) return disabled();
  // Only reached with a resolved badge; both event types are offered to every
  // badge (they only ever carry that badge's own approvals).
  void cred;
  return { ok: true, result: { events: listEventDefinitions() } };
}

// ---- events/subscribe ----------------------------------------------------
type SubscribeKey = { name: McpEventName; url: string; host: string; args: ReturnType<typeof validateEventArguments> & { ok: true } };

function parseKey(params: Record<string, unknown>, requireSecret: boolean):
  | { ok: true; key: SubscribeKey; secret?: string; ttl: number | null | undefined }
  | { ok: false; error: McpEventsRpcResult } {
  const name = params.name;
  if (typeof name !== "string" || !name) return { ok: false, error: err(-32602, "name is required") };
  if (!isMcpEventName(name)) return { ok: false, error: err(-32011, "Event not found", { kind: "event" }) };
  const delivery = params.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return { ok: false, error: err(-32602, "delivery is required") };
  const d = delivery as Record<string, unknown>;
  if (requireSecret && d.mode !== undefined && d.mode !== "webhook") {
    return { ok: false, error: err(-32014, "Delivery mode not supported", { feature: "deliveryMode", value: String(d.mode).slice(0, 20) }) };
  }
  const url = validateCallbackUrl(d.url);
  if (!url.ok) return { ok: false, error: err(-32602, `delivery.url rejected: ${url.reason}`) };
  let secret: string | undefined;
  if (requireSecret) {
    if (!parseWhsecSecret(d.secret).ok) return { ok: false, error: err(-32602, "delivery.secret must be whsec_ + base64 of 24–64 bytes") };
    secret = d.secret as string;
  }
  const args = validateEventArguments(name, params.arguments);
  if (!args.ok) return { ok: false, error: err(-32602, args.message) };
  const ttl = params.ttlMs;
  if (ttl !== undefined && ttl !== null && (typeof ttl !== "number" || !Number.isFinite(ttl))) {
    return { ok: false, error: err(-32602, "ttlMs must be a number or null") };
  }
  return { ok: true, key: { name, url: d.url as string, host: url.host, args }, secret, ttl: ttl as number | null | undefined };
}

async function verifyEndpoint(input: { url: string; host: string; key: Buffer; subscriptionId: string; now: number }): Promise<McpEventsRpcResult | null> {
  // D11: shared per-host budget (all instances). Unreachable counter → refuse (fail closed, retryable).
  const budget = await store.takeVerificationBudget(input.host, input.now, L.verificationsPerHostPerMinute);
  if (budget === "unavailable") return err(-32603, "Internal error", { reason: "verification_rate_unavailable", retryable: true });
  if (budget === "limited") return err(-32013, "Verification rate limit", { limit: "verification_rate" });
  const challenge = randomBytes(24).toString("base64url");
  const body = JSON.stringify({ type: "verification", challenge });
  const msgId = `msg_verification_${randomBytes(16).toString("base64url")}`;
  const ts = Math.floor(input.now / 1000);
  const res = await postWebhook(input.url, body, {
    "content-type": "application/json",
    "webhook-id": msgId,
    "webhook-timestamp": String(ts),
    "webhook-signature": signStandardWebhook([input.key], msgId, ts, body),
    "x-mcp-subscription-id": input.subscriptionId,
  }, transport());
  if (!res.ok) return err(-32015, "Callback endpoint error", { reason: res.category });
  let echoed: unknown;
  try { echoed = (JSON.parse(res.body.toString("utf8")) as { challenge?: unknown }).challenge; } catch { echoed = null; }
  const a = Buffer.from(typeof echoed === "string" ? echoed : "");
  const b = Buffer.from(challenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return err(-32015, "Callback endpoint error", { reason: "challenge_failed" });
  return null;
}

export async function handleEventsSubscribe(cred: ResolvedEmployeeCredential, params: Record<string, unknown>): Promise<McpEventsRpcResult> {
  if (!isMcpEventsEnabled()) return disabled();
  const parsed = parseKey(params || {}, true);
  if (!parsed.ok) return parsed.error;
  const { key, secret } = parsed;
  const args = key.args.args;
  const now = nowMs();
  const nowIso = iso(now);

  // Same live badge check as every delivery attempt (binding / generation /
  // employee / credential row): a subscription never starts from a stale badge.
  const live = await checkSubscriptionPrincipal({
    orgId: cred.orgId, employeeId: cred.employeeId, credentialGeneration: cred.generation,
    credentialFingerprint: cred.fingerprint, credentialId: cred.credentialId,
  }, now);
  if (!live.ok) {
    // A read error is not a revocation: answer a retryable internal error and
    // change nothing (the client retries the subscribe).
    if (live.kind === "unavailable") return err(-32603, "Internal error", { reason: live.reason });
    return err(-32012, "Forbidden", { reason: "revoked" });
  }

  if (args.approvalId) {
    const approval = await getApprovalById(args.approvalId, cred.orgId).catch(() => null);
    if (!approval || approval.employeeId !== cred.employeeId) return err(-32012, "Forbidden");
  }

  const principal = principalFor(cred);
  const id = subscriptionId({ principal, url: key.url, name: key.name, args });
  const existing = await store.getEventSubscription(id);
  if (existing && (existing.status === "revoked" || existing.orgId !== cred.orgId || existing.employeeId !== cred.employeeId)) {
    return err(-32012, "Forbidden", { reason: "revoked" });
  }
  const liveExisting = existing && existing.status === "active" && Date.parse(existing.refreshBefore) > now;
  if (!liveExisting && (await store.countActiveEventSubscriptions(cred.orgId, cred.employeeId, nowIso)) >= L.maxSubscriptionsPerEmployee) {
    return err(-32013, "Subscription limit reached", { limit: "subscriptions", max: L.maxSubscriptionsPerEmployee });
  }

  const secretKey = (parseWhsecSecret(secret) as { ok: true; key: Buffer }).key;
  const cachedVerified = await store.isVerifiedFor(principal, key.url, iso(now - L.verificationCacheMs));
  if (!cachedVerified) {
    const failed = await verifyEndpoint({ url: key.url, host: key.host, key: secretKey, subscriptionId: id, now });
    if (failed) return failed;
  }

  let secretCiphertext: string;
  try {
    secretCiphertext = encryptNotificationSecrets({ secret: secret! });
  } catch {
    return err(-32603, "Internal error", { reason: "server_not_configured" });
  }
  const secretFingerprint = sha256(secret!);
  const rotated = Boolean(existing && existing.secretFingerprint !== secretFingerprint);
  const { risk, reasons } = classifySubscriptionRisk({ host: key.host, args, requestedTtlMs: parsed.ttl });
  const grant = grantSubscriptionTtl({ requestedTtlMs: parsed.ttl, risk });
  const refreshBefore = iso(now + grant.ttlMs);
  const row: store.SubscriptionRow = {
    id,
    orgId: cred.orgId,
    employeeId: cred.employeeId,
    credentialId: cred.credentialId,
    credentialGeneration: cred.generation,
    credentialFingerprint: cred.fingerprint,
    principal,
    eventName: key.name,
    arguments: args,
    deliveryUrl: key.url,
    deliveryHost: key.host,
    secretCiphertext,
    secretFingerprint,
    previousSecretCiphertext: rotated ? existing!.secretCiphertext : existing?.previousSecretCiphertext ?? null,
    previousSecretValidUntil: rotated ? iso(now + 10 * 60_000) : existing?.previousSecretValidUntil ?? null,
    status: "active",
    risk,
    riskReasons: reasons,
    grantedTtlMs: grant.ttlMs,
    refreshBefore,
    verifiedAt: cachedVerified ? existing?.verifiedAt ?? nowIso : nowIso,
    lastDeliveryAt: existing?.lastDeliveryAt ?? null,
    lastError: existing?.lastError ?? null,
    failedSince: existing?.failedSince ?? null,
    revokedReason: null,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  await store.upsertEventSubscription(row);
  await audit({
    orgId: cred.orgId,
    employeeId: cred.employeeId,
    action: "mcp_events.subscribed",
    summary: existing ? "MCP Events の購読を更新" : "MCP Events の購読を登録（宛先確認済み）",
    metadata: {
      subscriptionId: id, eventName: key.name, receiverHost: key.host, receiverUrlHash: sha256(key.url).slice(0, 12),
      arguments: args, risk, riskReasons: reasons, grantedTtlMs: grant.ttlMs, ttlCapped: grant.capped,
      refreshBefore, refresh: Boolean(existing), secretRotated: rotated, verification: cachedVerified ? "cached" : "challenge",
    },
  });
  return {
    ok: true,
    result: {
      id,
      refreshBefore,
      cursor: null,
      truncated: false,
      ...(existing ? { deliveryStatus: { active: true, lastDeliveryAt: existing.lastDeliveryAt, lastError: existing.lastError } } : {}),
    },
  };
}

// ---- events/unsubscribe --------------------------------------------------
export async function handleEventsUnsubscribe(cred: ResolvedEmployeeCredential, params: Record<string, unknown>): Promise<McpEventsRpcResult> {
  if (!isMcpEventsEnabled()) return disabled();
  const parsed = parseKey(params || {}, false);
  if (!parsed.ok) return parsed.error;
  const { key } = parsed;
  const id = subscriptionId({ principal: principalFor(cred), url: key.url, name: key.name, args: key.args.args });
  const existing = await store.getEventSubscription(id);
  // Idempotent (ChatGPT): unknown / already-ended subscriptions also return {}.
  if (existing && existing.status === "active" && existing.orgId === cred.orgId && existing.employeeId === cred.employeeId) {
    const nowIso = iso(nowMs());
    await store.updateEventSubscription(id, { status: "unsubscribed", updatedAt: nowIso });
    await store.dropPendingDeliveries([id], "unsubscribed", nowIso);
    await audit({
      orgId: cred.orgId, employeeId: cred.employeeId, action: "mcp_events.unsubscribed",
      summary: "MCP Events の購読を停止", metadata: { subscriptionId: id, eventName: key.name, receiverHost: key.host },
    });
  }
  return { ok: true, result: {} };
}

// ---- emit ----------------------------------------------------------------
export type EmitResult = { eventId: string | null; enqueued: number; skipped?: string };

export function expiredReasonFromMeta(meta: Record<string, unknown> | undefined): ExpiredReason {
  if (meta?.phase === "approval.fulfill") return "closed_at_fulfil";
  if (meta?.reason === "deadline_exceeded") return "deadline_exceeded";
  return "ttl_elapsed";
}

/** Same eventId the emit would use (for the legacy callback dedupe field). */
export function approvalEventIdFor(approval: Pick<ApprovalRequest, "orgId" | "id" | "status">, name: McpEventName): string {
  return approvalEventId({ orgId: approval.orgId, approvalId: approval.id, name, status: eventStatus(approval as ApprovalRequest, name) });
}

export async function emitApprovalEvent(
  input: { approval: ApprovalRequest; name: McpEventName; reason?: ExpiredReason },
  opts: { deliver?: "inline" | "background" | "none" } = {}
): Promise<EmitResult> {
  if (!isMcpEventsEnabled()) return { eventId: null, enqueued: 0, skipped: "disabled" };
  const given = input.approval;
  if (!given?.employeeId || !given.orgId) return { eventId: null, enqueued: 0, skipped: "no_employee" };
  const fresh = await getApprovalById(given.id, given.orgId).catch(() => null);
  if (fresh && fresh.employeeId !== given.employeeId) return { eventId: null, enqueued: 0, skipped: "approval_mismatch" };
  let approval = given;
  if (input.name === "approval.decided") {
    approval = fresh ?? given;
    // Closed at fulfil (expired / superseded) after the decision: the expired event is the one that counts.
    if (!(DECIDED_STATUSES as readonly string[]).includes(approval.status)) return { eventId: null, enqueued: 0, skipped: "not_decided" };
  }
  const now = nowMs();
  const nowIso = iso(now);
  const status = eventStatus(approval, input.name);
  const eventId = approvalEventId({ orgId: approval.orgId, approvalId: approval.id, name: input.name, status });
  const data = buildApprovalEventData(approval, input.name, { reason: input.reason, nowIso });
  const subs = (await store.listDeliverableEventSubscriptions(approval.orgId, approval.employeeId, input.name, nowIso))
    .filter((s) => s.orgId === approval.orgId && s.employeeId === approval.employeeId)
    .filter((s) => matchesArguments(s.arguments, { approvalId: approval.id, jobId: data.jobId, risk: approval.risk, status }, input.name));
  if (!subs.length) return { eventId, enqueued: 0 };
  const body = buildEventBody({ eventId, name: input.name, timestampIso: nowIso, data });
  if (Buffer.byteLength(body, "utf8") > L.maxBodyBytes) return { eventId, enqueued: 0, skipped: "body_too_large" };
  const ids: string[] = [];
  for (const sub of subs) {
    const row: store.DeliveryRow = {
      id: randomUUID(), orgId: sub.orgId, employeeId: sub.employeeId, subscriptionId: sub.id, eventId,
      eventName: input.name, approvalId: approval.id, body, status: "pending", attempts: 0,
      nextAttemptAt: nowIso, leaseUntil: null, lastStatus: null, lastError: null, deliveredAt: null,
      attributedAt: null, createdAt: nowIso, updatedAt: nowIso,
    };
    if (await store.enqueueDelivery(row)) ids.push(row.id);
  }
  const deliver = opts.deliver ?? "background";
  const work = async () => { for (const id of ids) await attemptDelivery(id); };
  if (deliver === "inline") await work();
  else if (deliver === "background" && ids.length) runInBackground(work());
  return { eventId, enqueued: ids.length };
}

// ---- delivery ------------------------------------------------------------
type AttemptOutcome = "delivered" | "retry" | "abandoned" | "dropped" | "deferred" | "skipped";

async function revokeEmployeeSubscriptions(orgId: string, employeeId: string, reason: string, nowIso: string): Promise<void> {
  const ids = await store.markRevokedForEmployee(orgId, employeeId, reason, nowIso);
  const dropped = await store.dropPendingDeliveries(ids, "subscription_revoked", nowIso);
  if (ids.length) {
    await audit({
      orgId, employeeId, action: "mcp_events.subscription_revoked",
      summary: "権限の変化を検知し MCP Events の配信を停止（再購読は拒否）",
      metadata: { reason, subscriptionIds: ids, droppedDeliveries: dropped },
    });
  }
}

function signingKeys(sub: store.SubscriptionRow, now: number): Buffer[] {
  const keys: Buffer[] = [];
  const add = (ct: string | null) => {
    if (!ct) return;
    const parsed = parseWhsecSecret(decryptNotificationSecrets(ct).secret);
    if (parsed.ok) keys.push(parsed.key);
  };
  add(sub.secretCiphertext);
  if (sub.previousSecretValidUntil && Date.parse(sub.previousSecretValidUntil) > now) add(sub.previousSecretCiphertext);
  return keys;
}

class PreSendUnavailable extends Error {
  constructor(readonly reason: string, readonly detail: string) { super(reason); }
}

/**
 * One delivery attempt.
 *
 * Attempt accounting (木村 review, 2026-10-05):
 * - `claimDelivery` counts the attempt (attempts + 1) atomically with the
 *   lease, so a worker that dies after claiming still used it up; a claim past
 *   maxAttempts sends nothing and abandons (max_attempts_exceeded).
 * - Before anything is sent, a check that could not run (revocation re-check
 *   read error, store error) DEFERS the attempt: the count is restored, the
 *   row is due again after deferMs, nothing is revoked or dropped. Deferrals
 *   are bounded by the same retry window (15 min from enqueue); past it the
 *   delivery is abandoned with reason revocation_check_unavailable.
 * - Once the POST may have left (DNS resolved and the request started), the
 *   attempt always counts.
 */
async function attemptDelivery(id: string): Promise<AttemptOutcome> {
  const now = nowMs();
  const nowIso = iso(now);
  const d = await store.claimDelivery(id, nowIso, iso(now + L.leaseMs));
  if (!d) return "skipped";
  const attempt = d.attempts;
  const sentBefore = attempt - 1;
  const meta = { eventId: d.eventId, eventName: d.eventName, approvalId: d.approvalId, subscriptionId: d.subscriptionId };

  const abandon = async (input: { attempts: number; reason: string; lastError: string; status?: number | null; receiverHost?: string }) => {
    await store.updateDelivery(id, { status: "abandoned", attempts: input.attempts, lastStatus: input.status ?? null, lastError: input.reason, leaseUntil: null, updatedAt: nowIso });
    await audit({
      orgId: d.orgId, employeeId: d.employeeId, action: "mcp_events.delivery_abandoned",
      summary: "MCP Events の配信をあきらめた（再送上限 / 再送しない応答 / 確認できない状態が続いた）",
      metadata: { ...meta, receiverHost: input.receiverHost ?? null, attempts: input.attempts, lastError: input.lastError, reason: input.reason },
    });
    return "abandoned" as const;
  };
  const drop = async (reason: string) => {
    await store.updateDelivery(id, { status: "dropped", attempts: sentBefore, lastError: reason, leaseUntil: null, updatedAt: nowIso });
    return "dropped" as const;
  };

  if (attempt > L.maxAttempts) {
    return abandon({ attempts: sentBefore, reason: "max_attempts_exceeded", lastError: d.lastError ?? "max_attempts_exceeded" });
  }

  // ---- pre-send checks: nothing has been sent yet ----
  let sub: store.SubscriptionRow;
  let keys: Buffer[];
  try {
    const found = await store.getEventSubscription(d.subscriptionId).catch(() => { throw new PreSendUnavailable("store_unavailable", "subscription_read"); });
    if (!found || found.orgId !== d.orgId || found.employeeId !== d.employeeId) return drop("subscription_missing");
    if (found.status !== "active") return drop(`subscription_${found.status}`);
    if (Date.parse(found.refreshBefore) <= now) {
      await store.updateEventSubscription(found.id, { status: "expired", updatedAt: nowIso });
      return drop("subscription_expired");
    }
    const principal = await checkSubscriptionPrincipal(found, now);
    if (!principal.ok && principal.kind === "unavailable") throw new PreSendUnavailable(principal.reason, principal.detail);
    if (!principal.ok) {
      // Positively known revocation only: stop every subscription of this employee.
      await revokeEmployeeSubscriptions(found.orgId, found.employeeId, principal.reason, nowIso);
      return drop("subscription_revoked");
    }
    sub = found;
    try { keys = signingKeys(sub, now); } catch { keys = []; }
  } catch (e) {
    const reason = e instanceof PreSendUnavailable ? e.reason : "store_unavailable";
    const detail = e instanceof PreSendUnavailable ? e.detail : "pre_send_threw";
    return defer({ d, attempt, now, nowIso, reason, detail, abandon });
  }
  if (!keys.length) return drop("secret_unavailable");

  // ---- send: from here on the attempt counts ----
  const ts = Math.floor(now / 1000);
  const res = await postWebhook(sub.deliveryUrl, d.body, {
    "content-type": "application/json",
    "webhook-id": d.eventId,
    "webhook-timestamp": String(ts),
    "webhook-signature": signStandardWebhook(keys, d.eventId, ts, d.body),
    "x-mcp-subscription-id": sub.id,
  }, transport());

  if (res.ok) {
    await store.updateDelivery(id, { status: "delivered", attempts: attempt, lastStatus: res.status, lastError: null, deliveredAt: nowIso, leaseUntil: null, updatedAt: nowIso });
    await store.updateEventSubscription(sub.id, { lastDeliveryAt: nowIso, lastError: null, failedSince: null, updatedAt: nowIso });
    await audit({
      orgId: d.orgId, employeeId: d.employeeId, action: "mcp_events.delivered",
      summary: "MCP Events で AI を起こした（承認の結果）",
      metadata: { ...meta, subscriptionId: sub.id, receiverHost: sub.deliveryHost, attempt, status: res.status },
    });
    return "delivered";
  }
  const nextDelay = L.backoffMs[attempt - 1];
  const nextAt = nextDelay === undefined ? Number.POSITIVE_INFINITY : now + nextDelay;
  const giveUp = !res.retryable || attempt >= L.maxAttempts || nextAt - Date.parse(d.createdAt) > L.retryWindowMs;
  await store.updateEventSubscription(sub.id, { lastError: res.category, failedSince: sub.failedSince ?? nowIso, updatedAt: nowIso });
  if (giveUp) {
    return abandon({ attempts: attempt, reason: res.reason, lastError: res.category, status: res.status ?? null, receiverHost: sub.deliveryHost });
  }
  await store.updateDelivery(id, { status: "pending", attempts: attempt, lastStatus: res.status ?? null, lastError: res.reason, nextAttemptAt: iso(nextAt), leaseUntil: null, updatedAt: nowIso });
  return "retry";
}

async function defer(input: {
  d: store.DeliveryRow; attempt: number; now: number; nowIso: string; reason: string; detail: string;
  abandon: (i: { attempts: number; reason: string; lastError: string }) => Promise<"abandoned">;
}): Promise<AttemptOutcome> {
  const { d, attempt, now, nowIso, reason, detail } = input;
  const nextAt = now + L.deferMs;
  console.warn("mcp_events_delivery_deferred", { eventId: d.eventId, subscriptionId: d.subscriptionId, reason, detail });
  if (nextAt - Date.parse(d.createdAt) > L.retryWindowMs) {
    return input.abandon({ attempts: attempt - 1, reason, lastError: reason });
  }
  const first = d.lastError !== reason;
  await store.releaseDeferredDelivery(d.id, attempt, { nextAttemptAt: iso(nextAt), lastError: reason, updatedAt: nowIso });
  if (first) {
    // Audited once per delivery (the first deferral); every deferral is logged.
    await audit({
      orgId: d.orgId, employeeId: d.employeeId, action: "mcp_events.delivery_deferred",
      summary: "権限の確認ができなかったため配信を延期（取り消しはしていない）",
      metadata: { eventId: d.eventId, eventName: d.eventName, approvalId: d.approvalId, subscriptionId: d.subscriptionId, reason, detail, nextAttemptAt: iso(nextAt), attemptsSoFar: attempt - 1 },
    });
  }
  return "deferred";
}

export async function deliverDueEvents(opts: { limit?: number } = {}): Promise<
  { skipped: "disabled" } | { attempted: number; delivered: number; retry: number; abandoned: number; dropped: number; deferred: number; errors: number }
> {
  if (!isMcpEventsEnabled()) return { skipped: "disabled" };
  const ids = await store.listDueDeliveryIds(iso(nowMs()), Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const out = { attempted: 0, delivered: 0, retry: 0, abandoned: 0, dropped: 0, deferred: 0, errors: 0 };
  for (const id of ids) {
    let r: AttemptOutcome;
    try {
      r = await attemptDelivery(id);
    } catch {
      // e.g. the store failed after the POST: the claimed attempt stays counted and
      // the lease expires, so the next run retries it (receivers dedupe by webhook-id).
      out.errors++;
      continue;
    }
    if (r === "skipped") continue;
    if (r === "deferred") { out.deferred++; continue; }
    out.attempted++;
    out[r]++;
  }
  return out;
}

/** Retention (deliveryRetentionMs, 7 days): delete finished delivery rows. Called by the deliver cron. */
export async function pruneFinishedDeliveries(opts: { limit?: number } = {}): Promise<{ deleted: number }> {
  if (!isMcpEventsEnabled()) return { deleted: 0 };
  const cutoff = iso(nowMs() - L.deliveryRetentionMs);
  const deleted = await store.deleteFinishedDeliveriesBefore(cutoff, Math.min(Math.max(opts.limit ?? 500, 1), 1000));
  return { deleted };
}

/** D11: deletes per-host verification-budget windows older than verificationWindowRetentionMs (deliver cron). */
export async function pruneVerificationWindows(): Promise<{ deleted: number }> {
  if (!isMcpEventsEnabled()) return { deleted: 0 };
  const deleted = await store.deleteVerificationWindowsBefore(iso(nowMs() - L.verificationWindowRetentionMs));
  return { deleted };
}

// ---- "what woke the AI" ----------------------------------------------------
/**
 * Called on authenticated tools/call. Links the FIRST tool call of the badge
 * within 30 min after a delivery to that event (once per delivery). Temporal
 * correlation only: an event is never authorization; the tool call itself
 * went through the normal Gateway checks.
 */
export async function recordTriggeredAction(cred: ResolvedEmployeeCredential, toolName: string): Promise<void> {
  if (!isMcpEventsEnabled()) return;
  const now = nowMs();
  const d = await store.findAttributableDelivery(cred.orgId, cred.employeeId, iso(now - L.attributionWindowMs));
  if (!d || !(await store.markAttributed(d.id, iso(now)))) return;
  await audit({
    orgId: cred.orgId, employeeId: cred.employeeId, action: "mcp_events.triggered_action",
    summary: "MCP Events の通知の後、AI が最初に行った操作",
    metadata: {
      eventId: d.eventId, eventName: d.eventName, approvalId: d.approvalId, subscriptionId: d.subscriptionId,
      tool: toolName.slice(0, 64), lagMs: d.deliveredAt ? now - Date.parse(d.deliveredAt) : null,
      basis: "first_tool_call_after_delivery",
    },
  });
}

// ---- ledger (receiver / subscription settings, no secrets) -----------------
export async function listSubscriptionLedger(orgId: string) {
  const rows = await store.listEventSubscriptionsForOrg(orgId);
  return rows.map((s) => ({
    id: s.id,
    employeeId: s.employeeId,
    eventName: s.eventName,
    arguments: s.arguments,
    receiverHost: s.deliveryHost,
    receiverUrlHash: sha256(s.deliveryUrl).slice(0, 12),
    status: s.status,
    risk: s.risk,
    riskReasons: s.riskReasons,
    grantedTtlMs: s.grantedTtlMs,
    refreshBefore: s.refreshBefore,
    verifiedAt: s.verifiedAt,
    lastDeliveryAt: s.lastDeliveryAt,
    lastError: s.lastError,
    failedSince: s.failedSince,
    revokedReason: s.revokedReason,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}
