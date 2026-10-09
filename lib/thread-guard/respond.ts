/**
 * Thread single-flight stop → audit row (no thread ids, no text: a 12-hex
 * prefix of the keyed thread hash, codes, read-point source / ts only).
 * Audit failures never turn a stop into a send.
 */
import { appendAuditEvent } from "@/lib/data";
import type { AuditAction } from "@/lib/types";
import { THREAD_BUSY, THREAD_GUARD_UNAVAILABLE, THREAD_MOVED_ON, type ThreadGuardCode, type ThreadGuardStop } from "./guard";

export function isThreadGuardCode(code: unknown): code is ThreadGuardCode {
  return code === THREAD_BUSY || code === THREAD_MOVED_ON || code === THREAD_GUARD_UNAVAILABLE;
}

const ACTION: Record<ThreadGuardCode, AuditAction> = {
  thread_busy: "thread_guard.busy",
  thread_moved_on: "thread_guard.moved_on",
  thread_guard_unavailable: "thread_guard.unavailable",
};
const SUMMARY: Record<ThreadGuardCode, string> = {
  thread_busy: "同じスレッドへ送信中の返信があるため送信せず（thread_busy）",
  thread_moved_on: "読んだ時点より後に自分の投稿があるため送信せず（thread_moved_on）",
  thread_guard_unavailable: "スレッド同時送信チェック不可のため送信せず（fail-closed）",
};

export type ThreadGuardAuditCtx = {
  orgId: string;
  employeeId: string;
  credentialId?: string | null;
  purpose: string;
  tool: string;
  jobId?: string | null;
  approvalId?: string;
  phase: "invoke" | "fulfil";
};

export async function auditThreadGuardStop(stop: ThreadGuardStop, ctx: ThreadGuardAuditCtx): Promise<void> {
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId ?? null,
    action: ACTION[stop.code],
    purpose: ctx.purpose,
    summary: SUMMARY[stop.code],
    metadata: {
      tool: ctx.tool,
      jobId: ctx.jobId,
      ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
      phase: ctx.phase,
      ...stop.audit,
    },
  }).catch(() => undefined);
}
