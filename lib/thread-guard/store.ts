/**
 * Thread single-flight store (migration 20261009100000). Hash-only: the
 * thread is an HMAC key (lib/thread-guard/guard.ts threadKeyFor), never a
 * channel / thread id or any message text.
 *
 * - thread_send_leases: one row per org × thread key; acquire is atomic in
 *   acquire_thread_send_lease (insert, or take over only an expired row);
 *   release deletes only the holder's row (org + key + lease id).
 * - thread_self_posts: each AI employee's latest post per org × thread key
 *   (µs timestamp + keyed job hash); record_thread_self_post only moves forward.
 *   Only posts made through Staffpass are recorded, so human posts never count.
 *   readLatestAiPostAfter reads every AI employee of the SAME org (木村 #286
 *   decision 4); another org's rows are never read.
 * Every function is scoped by org (and employee for posts): another org's
 * rows are never read, taken over or released. service_role only.
 * Demo mode keeps the same semantics in memory.
 */
import { randomUUID } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { threadGuardNow } from "./config";

export type LeaseResult =
  | { state: "acquired"; leaseId: string; expiresAtMs: number }
  | { state: "busy"; retryAfterSeconds: number }
  | { state: "unavailable"; reason: string };

export type SelfPost = { micros: bigint; jobKey: string | null };
export type AiPost = SelfPost & { employeeId: string };

const HEX64 = /^[0-9a-f]{64}$/;
const valid = (orgId: string, threadKey: string) => Boolean(orgId) && HEX64.test(threadKey);

type DemoLease = { leaseId: string; employeeId: string; expiresAtMs: number };
const demoLeases = new Map<string, DemoLease>();
const demoPosts = new Map<string, AiPost>();
type Failure = null | "acquire" | "read" | "release" | "record";
let failure: Failure = null;

/** Tests only. */
export function __resetThreadGuardStoreForTests(): void {
  demoLeases.clear();
  demoPosts.clear();
}
/** Tests only: make one store operation fail (fail-closed paths). */
export function __setThreadGuardStoreFailureForTests(kind: Failure): void {
  failure = kind;
}

const leaseKey = (orgId: string, threadKey: string) => `${orgId}\u0000${threadKey}`;
const postKey = (orgId: string, employeeId: string, threadKey: string) => `${orgId}\u0000${employeeId}\u0000${threadKey}`;

export async function acquireThreadLease(input: {
  orgId: string;
  employeeId: string;
  threadKey: string;
  ttlSeconds: number;
}): Promise<LeaseResult> {
  if (failure === "acquire") return { state: "unavailable", reason: "lease_store_error" };
  if (!valid(input.orgId, input.threadKey) || !input.employeeId) return { state: "unavailable", reason: "invalid_input" };
  const leaseId = randomUUID();
  if (isDemoMode()) {
    const now = threadGuardNow();
    const k = leaseKey(input.orgId, input.threadKey);
    const held = demoLeases.get(k);
    if (held && held.expiresAtMs > now) {
      return { state: "busy", retryAfterSeconds: Math.max(1, Math.ceil((held.expiresAtMs - now) / 1000)) };
    }
    const expiresAtMs = now + input.ttlSeconds * 1000;
    demoLeases.set(k, { leaseId, employeeId: input.employeeId, expiresAtMs });
    return { state: "acquired", leaseId, expiresAtMs };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable", reason: "lease_store_unconfigured" };
  try {
    const { data, error } = await admin.rpc("acquire_thread_send_lease", {
      p_org: input.orgId,
      p_thread_key: input.threadKey,
      p_employee: input.employeeId,
      p_lease: leaseId,
      p_ttl_seconds: input.ttlSeconds,
    });
    const r = (data ?? {}) as { state?: string; retry_after_seconds?: number; expires_at?: string };
    if (error || !r.state) return { state: "unavailable", reason: "lease_store_error" };
    if (r.state === "acquired") return { state: "acquired", leaseId, expiresAtMs: Date.parse(String(r.expires_at)) || Date.now() + input.ttlSeconds * 1000 };
    if (r.state === "busy") return { state: "busy", retryAfterSeconds: Math.max(1, Math.ceil(Number(r.retry_after_seconds) || 1)) };
    return { state: "unavailable", reason: `lease_${r.state}` };
  } catch {
    return { state: "unavailable", reason: "lease_store_error" };
  }
}

/** Releases only the holder's own lease. false = not held (expired + re-taken) or store error (it expires by TTL). */
export async function releaseThreadLease(input: { orgId: string; threadKey: string; leaseId: string }): Promise<boolean> {
  if (failure === "release") return false;
  if (!valid(input.orgId, input.threadKey) || !input.leaseId) return false;
  if (isDemoMode()) {
    const k = leaseKey(input.orgId, input.threadKey);
    const held = demoLeases.get(k);
    if (!held || held.leaseId !== input.leaseId) return false;
    demoLeases.delete(k);
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  try {
    const { data, error } = await admin.rpc("release_thread_send_lease", {
      p_org: input.orgId,
      p_thread_key: input.threadKey,
      p_lease: input.leaseId,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function readLastSelfPost(input: {
  orgId: string;
  employeeId: string;
  threadKey: string;
}): Promise<{ ok: true; post: SelfPost | null } | { ok: false }> {
  if (failure === "read") return { ok: false };
  if (!valid(input.orgId, input.threadKey) || !input.employeeId) return { ok: false };
  if (isDemoMode()) {
    const post = demoPosts.get(postKey(input.orgId, input.employeeId, input.threadKey));
    return { ok: true, post: post ? { micros: post.micros, jobKey: post.jobKey } : null };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false };
  try {
    const { data, error } = await admin
      .from("thread_self_posts")
      .select("message_micros, job_key")
      .eq("org_id", input.orgId)
      .eq("employee_id", input.employeeId)
      .eq("thread_key", input.threadKey)
      .maybeSingle();
    if (error) return { ok: false };
    if (!data) return { ok: true, post: null };
    const row = data as { message_micros?: number | string; job_key?: string | null };
    const micros = BigInt(String(row.message_micros ?? "0").split(".")[0] || "0");
    return { ok: true, post: { micros, jobKey: row.job_key ?? null } };
  } catch {
    return { ok: false };
  }
}

/**
 * The newest AI post in this thread (any employee of THIS org) strictly after
 * `afterMicros`, skipping the row whose job key is `excludeJobKey` (the
 * caller's own same-job post: a multi-part reply). null = none.
 */
export async function readLatestAiPostAfter(input: {
  orgId: string;
  threadKey: string;
  afterMicros: bigint;
  excludeJobKey: string | null;
}): Promise<{ ok: true; post: AiPost | null } | { ok: false }> {
  if (failure === "read") return { ok: false };
  if (!valid(input.orgId, input.threadKey)) return { ok: false };
  const keep = (p: AiPost) => p.micros > input.afterMicros && !(input.excludeJobKey && p.jobKey === input.excludeJobKey);
  if (isDemoMode()) {
    const prefix = `${input.orgId}\u0000`;
    const suffix = `\u0000${input.threadKey}`;
    let best: AiPost | null = null;
    for (const [k, p] of demoPosts) {
      if (!k.startsWith(prefix) || !k.endsWith(suffix) || !keep(p)) continue;
      if (!best || p.micros > best.micros) best = p;
    }
    return { ok: true, post: best ? { ...best } : null };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false };
  try {
    const { data, error } = await admin
      .from("thread_self_posts")
      .select("message_micros, job_key, employee_id")
      .eq("org_id", input.orgId)
      .eq("thread_key", input.threadKey)
      .gt("message_micros", input.afterMicros.toString())
      .order("message_micros", { ascending: false })
      .limit(25);
    if (error || !Array.isArray(data)) return { ok: false };
    for (const raw of data as Array<{ message_micros?: number | string; job_key?: string | null; employee_id?: string }>) {
      const post: AiPost = {
        micros: BigInt(String(raw.message_micros ?? "0").split(".")[0] || "0"),
        jobKey: raw.job_key ?? null,
        employeeId: String(raw.employee_id ?? ""),
      };
      if (keep(post)) return { ok: true, post };
    }
    return { ok: true, post: null };
  } catch {
    return { ok: false };
  }
}

/** The employee's post in this thread (only moves forward). false = not recorded. */
export async function recordSelfPost(input: {
  orgId: string;
  employeeId: string;
  threadKey: string;
  micros: bigint;
  jobKey: string | null;
}): Promise<boolean> {
  if (failure === "record") return false;
  if (!valid(input.orgId, input.threadKey) || !input.employeeId || input.micros <= BigInt(0)) return false;
  if (isDemoMode()) {
    const k = postKey(input.orgId, input.employeeId, input.threadKey);
    const prev = demoPosts.get(k);
    if (!prev || input.micros > prev.micros) demoPosts.set(k, { micros: input.micros, jobKey: input.jobKey, employeeId: input.employeeId });
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  try {
    const { data, error } = await admin.rpc("record_thread_self_post", {
      p_org: input.orgId,
      p_employee: input.employeeId,
      p_thread_key: input.threadKey,
      p_message_micros: input.micros.toString(),
      p_job_key: input.jobKey,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}
