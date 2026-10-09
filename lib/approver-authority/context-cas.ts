/**
 * TOCTOU follow-up to F2 (木村 2026-10-09 23:58, item 2). F2 re-reads the
 * judged state right before fulfil; this makes the write itself a
 * compare-and-swap so a change between that check and the write cannot be
 * overwritten.
 *
 * The guard (approverContextGuardForWrite in ./filing) reads the judged
 * columns once, checks that their fingerprint equals the one recorded at
 * filing, and pins those raw values as `expected`. The write then happens
 * only if the row still equals `expected`:
 *   - production: one SQL RPC locks the row(s), compares and writes in one
 *     transaction (supabase/migrations/20261010100000_approver_context_cas.sql);
 *   - demo store: compared synchronously right before the in-memory write.
 * Mismatch → ApproverContextChangedError ("approver_context_changed", same
 * next step as F2) and nothing is written.
 *
 * No data imports here (lib/data/* imports this module).
 */
export type ContextPinnedTool = "policy.patch" | "schedulingPolicy.patch";

export interface ApproverContextGuard {
  approvalId: string;
  tool: ContextPinnedTool;
  /** The fingerprint recorded at filing (the RPC checks it against the ticket row too). */
  fingerprint: string;
  employeeId: string | null;
  /**
   * Raw judged values the write is conditioned on.
   * policy.patch: { scopes, allowed_purposes, approval_policy, action_limits, tool_approval_defaults }
   * schedulingPolicy.patch: { org } or { org, employee } (scheduling_policy, null = none)
   */
  expected: Record<string, unknown>;
}

export const APPROVER_CONTEXT_CHANGED = "approver_context_changed";

export class ApproverContextChangedError extends Error {
  readonly reason = APPROVER_CONTEXT_CHANGED;
  constructor() {
    super(APPROVER_CONTEXT_CHANGED);
    this.name = "ApproverContextChangedError";
  }
}

/** A refusal from the CAS RPC other than a context change (binding / input). Never retried silently. */
export class ApproverContextWriteRefusedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ApproverContextWriteRefusedError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Key-sorted JSON (jsonb-equality semantics: object key order does not matter, array order does). */
export function canonicalContextJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
      : isPlainRecord(v) ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sort(v[k])]))
      : v === undefined ? null : v;
  return JSON.stringify(sort(value));
}

/** The guard must belong to this write (tool, and target employee for per-employee writes). */
export function assertGuardFor(guard: ApproverContextGuard, tool: ContextPinnedTool, employeeId: string | null): void {
  if (!guard || guard.tool !== tool || !guard.fingerprint || !guard.approvalId || !isPlainRecord(guard.expected)) {
    throw new ApproverContextWriteRefusedError("context_guard_mismatch");
  }
  if ((guard.employeeId ?? null) !== (employeeId ?? null)) throw new ApproverContextWriteRefusedError("context_guard_mismatch");
}

/** Demo store: compare right before the in-memory write (no await in between). */
export function assertDemoContextUnchanged(guard: ApproverContextGuard, current: Record<string, unknown>): void {
  if (canonicalContextJson(current) !== canonicalContextJson(guard.expected)) throw new ApproverContextChangedError();
}

/** Map the CAS RPC answer. ok → data; context change → ApproverContextChangedError; anything else → fail closed. */
export function casResult(data: unknown, error: unknown): Record<string, unknown> {
  if (error) throw new ApproverContextWriteRefusedError("approver_context_cas_failed");
  if (!isPlainRecord(data)) throw new ApproverContextWriteRefusedError("approver_context_cas_failed");
  if (data.ok === true) return data;
  if (data.ok === false && data.reason === APPROVER_CONTEXT_CHANGED) throw new ApproverContextChangedError();
  if (data.ok === false && typeof data.reason === "string" && /^[a-z_]{1,64}$/.test(data.reason)) {
    throw new ApproverContextWriteRefusedError(data.reason);
  }
  throw new ApproverContextWriteRefusedError("approver_context_cas_failed");
}

/** The five policy.patch compared columns, in the raw shape the CAS RPC compares (snake_case, as stored). */
export function employeePolicyProjection(employee: {
  scopes?: readonly string[] | null;
  allowedPurposes?: readonly string[] | null;
  approvalPolicy?: string | null;
  actionLimits?: unknown;
  toolApprovalDefaults?: unknown;
}): Record<string, unknown> {
  return JSON.parse(canonicalContextJson({
    scopes: [...(employee.scopes ?? [])],
    allowed_purposes: [...(employee.allowedPurposes ?? [])],
    approval_policy: employee.approvalPolicy ?? null,
    action_limits: employee.actionLimits ?? {},
    tool_approval_defaults: employee.toolApprovalDefaults ?? {},
  })) as Record<string, unknown>;
}
