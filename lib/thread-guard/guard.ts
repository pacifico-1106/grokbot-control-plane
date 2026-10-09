/**
 * Thread single-flight (木村 2026-10-09 A, 八坂 GO; triage #2 — two concurrent
 * jobs posted opposite replies into one thread). THREAD_SINGLE_FLIGHT_ENABLED,
 * default OFF; OFF = no store access, nothing changes.
 *
 * beginThreadSend, right before a conversation post (direct, caller-delivered
 * or approval fulfil), in this order:
 *  1. thread key = HMAC (dedup key, own "thread" domain) of the org-scoped
 *     conversation key — the same place the duplicate post guard compares
 *  2. lease (TTL) on org × thread key — busy → 409 thread_busy (retryable)
 *  3. under the lease: has this employee posted in the thread after the read
 *     point (readThroughTs, else the inbound ts)? The same job's own earlier
 *     post does not count. Yes → 409 thread_moved_on (re-read first)
 *  then the caller posts and calls handle.finish(): a confirmed post is
 *  recorded as the employee's latest post in the thread, then the lease is
 *  released. Every caller releases in `finally` (finish is idempotent).
 *
 * Lease-store / key errors FAIL CLOSED (503 thread_guard_unavailable, nothing
 * sent): a post cannot be taken back, the flag exists to stop the double reply,
 * and the duplicate post guard on the same paths fails closed too. The lease
 * TTL bounds how long a crashed sender can block a thread.
 */
import { createHmac } from "node:crypto";
import { isThreadSingleFlightEnabled } from "@/lib/feature-flags";
import { resolveCommReplyDedupKey } from "@/lib/comm-reply-dedup/config";
import { conversationKey, type ConversationKeyInput } from "@/lib/comm-reply-dedup/conversation-key";
import { threadGuardNow, threadLeaseTtlSeconds } from "./config";
import { microsToTs, type ReadThrough } from "./read-through";
import { acquireThreadLease, readLastSelfPost, recordSelfPost, releaseThreadLease } from "./store";

export const THREAD_BUSY = "thread_busy";
export const THREAD_MOVED_ON = "thread_moved_on";
export const THREAD_GUARD_UNAVAILABLE = "thread_guard_unavailable";
export type ThreadGuardCode = typeof THREAD_BUSY | typeof THREAD_MOVED_ON | typeof THREAD_GUARD_UNAVAILABLE;

export const THREAD_BUSY_MESSAGE_JA = "同じスレッドへの別の返信を送信中のため、送信しませんでした。";
export const THREAD_MOVED_ON_MESSAGE_JA =
  "読んだ時点より後に、このスレッドへ自分の投稿がすでにあるため、送信しませんでした。スレッドを読み直してください。";
export const THREAD_GUARD_UNAVAILABLE_MESSAGE_JA = "スレッドの同時送信チェックが利用できないため、送信を止めました（fail-closed）。";

function nextStepBusy(seconds: number): string {
  return `Nothing was posted: another reply to this thread is being sent right now. Wait ${seconds} seconds, re-read the thread (including any new reply from yourself), then send only if your reply is still needed, with readThroughTs set to the latest message you read.`;
}
const NEXT_STEP_MOVED_ON =
  "Nothing was posted: you already posted in this thread after the point you read (readThroughTs, or the message you were woken by). Re-read the thread, then send a new reply only if it is still needed, with readThroughTs set to the latest message you read. Do not resend this reply as is.";
const NEXT_STEP_UNAVAILABLE =
  "Nothing was posted. The thread single-flight check is unavailable; retry the same request later (it is safe to retry).";

/** Separate HMAC domain: never equal to a duplicate-ledger key. */
export function threadKeyFor(input: ConversationKeyInput | null): string | null {
  const key = resolveCommReplyDedupKey();
  if (!key || !input) return null;
  const conv = conversationKey(input, key);
  return conv ? createHmac("sha256", key).update(`thread:v1:${conv}`).digest("hex") : null;
}

function jobKeyOf(orgId: string, employeeId: string, jobId: string | null | undefined): string | null {
  const key = resolveCommReplyDedupKey();
  const j = (jobId ?? "").trim();
  if (!key || !j) return null;
  return createHmac("sha256", key).update(["thread-job", "v1", orgId, employeeId, j].join("\u0000")).digest("hex");
}

export type ThreadGuardStop = {
  kind: "stop";
  code: ThreadGuardCode;
  httpStatus: 409 | 503;
  /** Response fields (merged into the tool's error body). */
  body: Record<string, unknown>;
  /** Audit metadata (no ids of the thread, no text). */
  audit: Record<string, unknown>;
};

export type ThreadSendHandle = {
  /** Record a confirmed post (messageTs = provider ts; absent = server time) and release. Idempotent. */
  finish(result: { sent: boolean; messageTs?: string | null }): Promise<void>;
};

export type BeginThreadSend = { kind: "off" } | ThreadGuardStop | { kind: "held"; handle: ThreadSendHandle };

export function threadGuardStopBody(code: ThreadGuardCode, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = { ok: false, code, error: code, reasonCode: code };
  if (code === THREAD_BUSY) {
    const seconds = Math.max(1, Number(extra.retryAfterSeconds) || 1);
    return { ...base, message: THREAD_BUSY_MESSAGE_JA, retryable: true, nextAction: "retry_later", retryAfterSeconds: seconds, nextStep: nextStepBusy(seconds) };
  }
  if (code === THREAD_MOVED_ON) {
    return { ...base, message: THREAD_MOVED_ON_MESSAGE_JA, retryable: false, nextAction: "reread_thread", ...extra, nextStep: NEXT_STEP_MOVED_ON };
  }
  return { ...base, message: THREAD_GUARD_UNAVAILABLE_MESSAGE_JA, retryable: true, nextAction: "retry_later", nextStep: NEXT_STEP_UNAVAILABLE };
}

function stop(code: ThreadGuardCode, extra: Record<string, unknown>, audit: Record<string, unknown>): ThreadGuardStop {
  return { kind: "stop", code, httpStatus: code === THREAD_GUARD_UNAVAILABLE ? 503 : 409, body: threadGuardStopBody(code, extra), audit: { code, ...audit } };
}

export async function beginThreadSend(input: {
  orgId: string;
  employeeId: string;
  jobId?: string | null;
  keyInput: ConversationKeyInput | null;
  readThrough: ReadThrough | null;
}): Promise<BeginThreadSend> {
  if (!isThreadSingleFlightEnabled()) return { kind: "off" };
  if (!input.keyInput) return { kind: "off" }; // no conversation destination: nothing to serialize
  const readThroughSource = input.readThrough?.source ?? "none";
  if (!input.orgId || !input.employeeId) return stop(THREAD_GUARD_UNAVAILABLE, {}, { reason: "scope_missing", readThroughSource });
  if (!resolveCommReplyDedupKey()) return stop(THREAD_GUARD_UNAVAILABLE, {}, { reason: "thread_key_missing", readThroughSource });
  const threadKey = threadKeyFor({ ...input.keyInput, orgId: input.orgId });
  if (!threadKey) return { kind: "off" };
  const keyRef = threadKey.slice(0, 12);

  const lease = await acquireThreadLease({ orgId: input.orgId, employeeId: input.employeeId, threadKey, ttlSeconds: threadLeaseTtlSeconds() });
  if (lease.state === "busy") {
    return stop(THREAD_BUSY, { retryAfterSeconds: lease.retryAfterSeconds }, { retryAfterSeconds: lease.retryAfterSeconds, threadKeyRef: keyRef, readThroughSource });
  }
  if (lease.state !== "acquired") return stop(THREAD_GUARD_UNAVAILABLE, {}, { reason: lease.reason, threadKeyRef: keyRef, readThroughSource });

  let done = false;
  const release = async () => {
    if (done) return;
    done = true;
    await releaseThreadLease({ orgId: input.orgId, threadKey, leaseId: lease.leaseId }).catch(() => false);
  };
  const jobKey = jobKeyOf(input.orgId, input.employeeId, input.jobId);

  try {
    if (input.readThrough) {
      const last = await readLastSelfPost({ orgId: input.orgId, employeeId: input.employeeId, threadKey });
      if (!last.ok) {
        await release();
        return stop(THREAD_GUARD_UNAVAILABLE, {}, { reason: "self_post_read_failed", threadKeyRef: keyRef, readThroughSource });
      }
      const newer = last.post && last.post.micros > input.readThrough.micros && !(jobKey && last.post.jobKey === jobKey);
      if (newer && last.post) {
        await release();
        const selfPostedTs = microsToTs(last.post.micros);
        return stop(
          THREAD_MOVED_ON,
          { readThroughTs: input.readThrough.ts, selfPostedTs },
          { threadKeyRef: keyRef, readThroughSource, readThroughTs: input.readThrough.ts, selfPostedTs }
        );
      }
    }
  } catch {
    await release();
    return stop(THREAD_GUARD_UNAVAILABLE, {}, { reason: "self_post_read_failed", threadKeyRef: keyRef, readThroughSource });
  }

  return {
    kind: "held",
    handle: {
      async finish(result) {
        if (done) return;
        try {
          if (result.sent) {
            const ts = (result.messageTs ?? "").trim();
            const m = /^(\d{9,11})\.(\d{1,6})$/.exec(ts);
            const micros = m ? BigInt(m[1]) * BigInt(1_000_000) + BigInt(m[2].padEnd(6, "0")) : BigInt(threadGuardNow()) * BigInt(1_000);
            const recorded = await recordSelfPost({ orgId: input.orgId, employeeId: input.employeeId, threadKey, micros, jobKey }).catch(() => false);
            if (!recorded) console.warn("[thread-guard] self post not recorded (moved_on may miss this post)", { threadKeyRef: keyRef });
          }
        } finally {
          await release();
        }
      },
    },
  };
}
