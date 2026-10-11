/**
 * Upload claim for the approved attachment (2026-10-04, #252 follow-up).
 *
 * One claim per approval, taken BEFORE anything is downloaded or uploaded, so
 * concurrent re-runs of the same approval upload at most once. The record lives
 * in `approval_requests.metadata.attachmentUpload` (no new table / column):
 *
 *   { state: "running" | "succeeded" | "failed" | "uncertain",
 *     claimId, refSha256, claimedAt, finishedAt?, fileId?, filename?, bytes?, code? }
 *
 *   running   → another worker holds the claim: do not upload (in_progress)
 *   succeeded → uploaded: never upload again (return the stored file id)
 *   failed    → failed before Slack could share the file: a later re-run may claim again
 *   uncertain → the outcome is unknown (the upload may have been shared):
 *               never retried automatically; the scheduled reconcile
 *               (lib/approvals/attachment-reconcile.ts) checks the conversation
 *               and settles it, or tells the admin agent once
 *
 * Production: atomic conditional update in the DB (RPC
 * claim_approval_attachment_upload / finish_approval_attachment_upload: row lock
 * on approval_requests, see supabase/migrations/*_approval_attachment_upload_claim.sql).
 * Any RPC error fails CLOSED ("unavailable" → no upload).
 * Demo: the check-and-set is one synchronous step on an in-process map (same
 * approach as the text claim in lib/approvals/execution.ts), mirrored to metadata.
 */
import { randomUUID } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { getApprovalById, updateApprovalMetadata } from "@/lib/data/approvals";
import type { ApprovalRequest } from "@/lib/types";
import {
  isDefinitePreShareSlackError,
  isSlackTokenType,
  sanitizeSlackScopes,
  type SlackTokenType,
} from "@/lib/slack/definite-errors";
import { settingsChangedSince } from "@/lib/approvals/attachment-retry-cap";
import { isApprovalAttachmentReconcileEnabled } from "@/lib/feature-flags";

export type AttachmentUploadState = "running" | "succeeded" | "failed" | "uncertain";
export type AttachmentUploadRecord = {
  state: AttachmentUploadState;
  claimId?: string;
  refSha256?: string;
  claimedAt?: string;
  finishedAt?: string;
  fileId?: string;
  filename?: string;
  bytes?: number;
  code?: string;
  /** Set by the scheduled reconcile (#253 follow-up): when it last settled / re-checked the record. */
  reconciledAt?: string;
  /** Set once, when the reconcile could not check and told the admin agent (stuck-watch a1 item). */
  adminNotifiedAt?: string;
  /**
   * 木村 2: re-checks after the notification back off. recheckAttempts = re-checks
   * done (0 at the notification), nextCheckAt = when the next one is due,
   * recheckStoppedAt = set (and nextCheckAt removed) once the next one would fall
   * past adminNotifiedAt + 24 h.
   */
  recheckAttempts?: number;
  nextCheckAt?: string;
  recheckStoppedAt?: string;
  /**
   * 木村 #255 second round: why the schedule stopped before it ran out —
   * stuck_watch_resolved = the admin agent closed the A1 item (stuckWatch.resolve).
   */
  recheckStopReason?: RecheckStopReason;
  /** 木村 5: failed because Slack answered a definite pre-share error (lib/slack/definite-errors.ts). */
  slackError?: string;
  /** missing_scope only: Slack's `needed` scope names (sanitized). */
  slackNeeded?: string[];
  /** With slackError only: which token Slack answered for (木村 #255 second round). */
  slackTokenType?: SlackTokenType;
};
export type RecheckStopReason = "stuck_watch_resolved";
const RECHECK_STOP_REASONS: readonly RecheckStopReason[] = ["stuck_watch_resolved"];
export type AttachmentUploadResult = {
  fileId?: string;
  filename?: string;
  bytes?: number;
  code?: string;
  slackError?: string;
  slackNeeded?: string[];
  slackTokenType?: SlackTokenType;
};
/** Re-check schedule written with an uncertain reconcile outcome (木村 2). */
export type AttachmentRecheckSchedule = { recheckAttempts: number; nextCheckAt?: string };

/** 木村 2: no automatic re-check later than this after the admin-agent notification. */
export const ATTACHMENT_RECHECK_WINDOW_MS = 24 * 60 * 60_000;
const MAX_RECHECK_ATTEMPTS = 100;

export type AttachmentUploadClaim =
  | { kind: "claimed"; claimId: string }
  | { kind: "succeeded"; fileId: string; filename: string; bytes: number }
  | { kind: "running" }
  | { kind: "uncertain" }
  | { kind: "denied" }
  | { kind: "unavailable" }
  /** 木村 #255 second round: same definite error `count` times in a row, no settings change since → no upload. */
  | { kind: "capped"; code: string; count: number };

/**
 * Consecutive definite failures of ONE approval with ONE Slack error code
 * (metadata.attachmentUploadStreak — outside attachmentUpload, so a new claim
 * does not wipe it). Written only by finish (row lock): failed + definite error
 * → same code: count + 1, other code: 1; any other outcome removes it.
 */
export type AttachmentUploadStreak = { code: string; count: number; lastAt: string };
const MAX_STREAK = 9999;

export function readAttachmentUploadStreak(metadata: Record<string, unknown> | null | undefined): AttachmentUploadStreak | null {
  const rec = obj(metadata?.attachmentUploadStreak);
  if (!rec) return null;
  const code = str(rec.code);
  const count = num(rec.count);
  const lastAt = str(rec.lastAt);
  if (!code || !isDefinitePreShareSlackError(code) || count === undefined || !Number.isInteger(count) || count < 1 || count > MAX_STREAK) return null;
  if (!lastAt || !Number.isFinite(Date.parse(lastAt))) return null;
  return { code, count, lastAt };
}

function nextStreak(prev: AttachmentUploadStreak | null, state: Exclude<AttachmentUploadState, "running">, picked: AttachmentUploadResult, at: string) {
  if (state !== "failed" || !picked.slackError) return undefined;
  const count = prev?.code === picked.slackError ? Math.min(prev.count + 1, MAX_STREAK) : 1;
  return { code: picked.slackError, count, lastAt: at };
}

/** Admin MCP stuck-watch item id for an attachment the reconcile could not check. */
export function attachmentUncertainItemId(approvalId: string): string {
  return `a1:${approvalId}`;
}

const STATES: readonly AttachmentUploadState[] = ["running", "succeeded", "failed", "uncertain"];
const demoClaims = new Map<string, AttachmentUploadRecord>();
/** Demo mirror of metadata.attachmentUploadStreak (null = cleared). */
const demoStreaks = new Map<string, AttachmentUploadStreak | null>();

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function readAttachmentUpload(metadata: Record<string, unknown> | null | undefined): AttachmentUploadRecord | null {
  const rec = obj(metadata?.attachmentUpload);
  if (!rec || !STATES.includes(rec.state as AttachmentUploadState)) return null;
  const out: AttachmentUploadRecord = { state: rec.state as AttachmentUploadState };
  for (const k of ["claimId", "refSha256", "claimedAt", "finishedAt", "fileId", "filename", "code", "reconciledAt",
    "adminNotifiedAt", "nextCheckAt", "recheckStoppedAt"] as const) {
    const v = str(rec[k]);
    if (v) out[k] = v;
  }
  const bytes = num(rec.bytes);
  if (bytes !== undefined) out.bytes = bytes;
  const attempts = num(rec.recheckAttempts);
  if (attempts !== undefined && Number.isInteger(attempts) && attempts >= 0 && attempts <= MAX_RECHECK_ATTEMPTS) {
    out.recheckAttempts = attempts;
  }
  if (RECHECK_STOP_REASONS.includes(rec.recheckStopReason as RecheckStopReason)) {
    out.recheckStopReason = rec.recheckStopReason as RecheckStopReason;
  }
  Object.assign(out, slackFields(rec.slackError, rec.slackNeeded, rec.slackTokenType));
  return out;
}

/**
 * Only a definite pre-share Slack error code, scope names for missing_scope and
 * the token type ("user" | "bot") — never anything else.
 */
function slackFields(
  error: unknown,
  needed: unknown,
  tokenType: unknown
): Pick<AttachmentUploadRecord, "slackError" | "slackNeeded" | "slackTokenType"> {
  if (typeof error !== "string" || !isDefinitePreShareSlackError(error)) return {};
  const scopes = error === "missing_scope" ? sanitizeSlackScopes(needed) : undefined;
  return {
    slackError: error,
    ...(scopes ? { slackNeeded: scopes } : {}),
    ...(isSlackTokenType(tokenType) ? { slackTokenType: tokenType } : {}),
  };
}

/** #252 wrote `attachmentFulfillment` after a successful upload (records already in production). */
function legacySuccess(metadata: Record<string, unknown> | null | undefined, refSha256: string) {
  const rec = obj(metadata?.attachmentFulfillment);
  if (!rec || rec.ok !== true || rec.refSha256 !== refSha256 || !str(rec.fileId)) return null;
  return { fileId: String(rec.fileId), filename: str(rec.filename) ?? "", bytes: num(rec.bytes) ?? 0 };
}

/** Only these fields ever reach the stored record (never a reference / URL / token). */
function pickResult(result: AttachmentUploadResult): AttachmentUploadResult {
  const out: AttachmentUploadResult = {};
  if (str(result.fileId)) out.fileId = result.fileId;
  if (str(result.filename)) out.filename = result.filename;
  if (num(result.bytes) !== undefined) out.bytes = result.bytes;
  if (str(result.code)) out.code = result.code;
  Object.assign(out, slackFields(result.slackError, result.slackNeeded, result.slackTokenType));
  return out;
}

function fromRpc(data: unknown): AttachmentUploadClaim | null {
  const rec = obj(data);
  switch (rec?.state) {
    case "running": return { kind: "running" };
    case "uncertain": return { kind: "uncertain" };
    case "denied": return { kind: "denied" };
    case "capped": {
      const count = num(rec.count);
      const code = str(rec.code);
      return code && count !== undefined ? { kind: "capped", code, count } : null;
    }
    case "succeeded": {
      const upload = obj(rec.upload) ?? {};
      const fileId = str(upload.fileId);
      return fileId ? { kind: "succeeded", fileId, filename: str(upload.filename) ?? "", bytes: num(upload.bytes) ?? 0 } : null;
    }
    default: return null;
  }
}

/**
 * opts.retryCap (木村 #255 second round, reconcile flag ON): refuse ("capped")
 * while the failed record's definite error has repeated retryCap times in a
 * row and the org's settings-change signal (public.org_settings_changes,
 * service_role only; 木村 third round h) is not newer than the last of them; a
 * newer signal clears the streak and the claim proceeds. Production: RPC
 * claim_approval_attachment_upload_capped (same row lock, then #253's claim).
 */
export async function claimAttachmentUpload(
  approval: ApprovalRequest,
  refSha256: string,
  opts: { retryCap?: number } = {}
): Promise<AttachmentUploadClaim> {
  const claimId = randomUUID();
  const cap = opts.retryCap !== undefined && Number.isInteger(opts.retryCap) && opts.retryCap >= 1 && opts.retryCap <= 10
    ? opts.retryCap : undefined;
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) return { kind: "unavailable" };
    try {
      const { data, error } = cap === undefined
        ? await admin.rpc("claim_approval_attachment_upload", {
            p_id: approval.id, p_org: approval.orgId, p_claim: claimId, p_ref: refSha256,
          })
        : await admin.rpc("claim_approval_attachment_upload_capped", {
            p_id: approval.id, p_org: approval.orgId, p_claim: claimId, p_ref: refSha256, p_cap: cap,
          });
      if (error || !data) return { kind: "unavailable" };
      if (obj(data)?.state === "claimed") return { kind: "claimed", claimId };
      return fromRpc(data) ?? { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  const current = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  const key = `${approval.orgId}:${approval.id}`;
  let resetStreak = false;
  if (cap !== undefined && current) {
    const streak = demoStreaks.has(key) ? demoStreaks.get(key)! : readAttachmentUploadStreak(current.metadata);
    const rec = demoClaims.get(key) ?? readAttachmentUpload(current.metadata);
    if (rec?.state === "failed" && streak && streak.code === rec.slackError && streak.count >= cap) {
      if (!(await settingsChangedSince(approval.orgId, streak.lastAt))) {
        return current.status === "approved" ? { kind: "capped", code: streak.code, count: streak.count } : { kind: "denied" };
      }
      resetStreak = true;
    }
  }
  // ---- synchronous check-and-set (no await until the claim is recorded) ----
  if (!current || current.status !== "approved") return { kind: "denied" };
  if (resetStreak) demoStreaks.set(key, null);
  const record = demoClaims.get(key) ?? readAttachmentUpload(current.metadata);
  const prior = legacySuccess(current.metadata, refSha256);
  if (prior) return { kind: "succeeded", ...prior };
  if (record?.state === "succeeded" && record.fileId) {
    return { kind: "succeeded", fileId: record.fileId, filename: record.filename ?? "", bytes: record.bytes ?? 0 };
  }
  if (record?.state === "running" || record?.state === "uncertain") return { kind: record.state };
  const claimed: AttachmentUploadRecord = { state: "running", claimId, refSha256, claimedAt: new Date().toISOString() };
  demoClaims.set(key, claimed);
  // ---------------------------------------------------------------------------
  await updateApprovalMetadata(current, {
    attachmentUpload: claimed, ...(resetStreak ? { attachmentUploadStreak: undefined } : {}),
  }).catch(() => undefined);
  return { kind: "claimed", claimId };
}

/**
 * Close the claim. Only the holder of a running claim can close it. Returns
 * false when the record could not be written (the claim then stays "running",
 * which blocks further uploads — fail closed).
 */
export async function finishAttachmentUpload(
  approval: ApprovalRequest,
  claimId: string,
  state: Exclude<AttachmentUploadState, "running">,
  result: AttachmentUploadResult
): Promise<boolean> {
  const picked = pickResult(result);
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) return false;
    try {
      const { data, error } = await admin.rpc("finish_approval_attachment_upload", {
        p_id: approval.id, p_org: approval.orgId, p_claim: claimId, p_state: state, p_result: picked,
      });
      return !error && data === true;
    } catch {
      return false;
    }
  }
  const key = `${approval.orgId}:${approval.id}`;
  const record = demoClaims.get(key);
  if (!record || record.state !== "running" || record.claimId !== claimId) return false;
  const at = new Date().toISOString();
  const next: AttachmentUploadRecord = { ...record, ...picked, state, finishedAt: at };
  demoClaims.set(key, next);
  const current = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  const prevStreak = demoStreaks.has(key) ? demoStreaks.get(key)! : readAttachmentUploadStreak(current?.metadata);
  const streak = nextStreak(prevStreak, state, picked, at);
  demoStreaks.set(key, streak ?? null);
  if (current) {
    await updateApprovalMetadata(current, { attachmentUpload: next, attachmentUploadStreak: streak }).catch(() => undefined);
  }
  return true;
}

/**
 * What the fulfillment result reports about the approved attachment.
 *   not_sent    — only the approved text was posted (approval callback / W2);
 *                 the agent re-run with the approvalId uploads the file
 *   sent        — uploaded once (file id)
 *   in_progress / uncertain / failed — the re-run's upload claim state
 */
export type FulfillmentFileUpload =
  | { status: "not_sent"; reason: "rerun_required"; filename: string; bytes?: number }
  | { status: "sent"; fileId: string; filename: string; bytes?: number }
  | {
      status: "in_progress" | "uncertain" | "failed";
      filename?: string;
      bytes?: number;
      code?: string;
      /** failed only: the definite Slack error (→ pollHint reinvoke_with_approvalId + reinvokeReason). */
      slackError?: string;
      slackNeeded?: string[];
      /** failed only, with slackError: which token failed (user | bot). */
      slackTokenType?: SlackTokenType;
    };

export function parseStoredFileUpload(value: unknown): FulfillmentFileUpload | undefined {
  const rec = obj(value);
  if (!rec || rec.status !== "not_sent" || rec.reason !== "rerun_required") return undefined;
  const filename = str(rec.filename);
  if (!filename) return undefined;
  const bytes = num(rec.bytes);
  return { status: "not_sent", reason: "rerun_required", filename, ...(bytes !== undefined ? { bytes } : {}) };
}

/** Live view: the upload claim record (or #252's attachmentFulfillment) wins over the stored marker. */
export function liveFileUpload(
  metadata: Record<string, unknown> | null | undefined,
  stored: FulfillmentFileUpload | undefined
): FulfillmentFileUpload | undefined {
  const upload = readAttachmentUpload(metadata);
  const display = (u: AttachmentUploadRecord) => ({
    ...(u.filename ? { filename: u.filename } : {}),
    ...(u.bytes !== undefined ? { bytes: u.bytes } : {}),
  });
  if (upload?.state === "succeeded" && upload.fileId) {
    return { status: "sent", fileId: upload.fileId, filename: upload.filename ?? "", ...(upload.bytes !== undefined ? { bytes: upload.bytes } : {}) };
  }
  if (upload?.state === "running") return { status: "in_progress", ...display(upload) };
  if (upload?.state === "uncertain") return { status: "uncertain", ...display(upload), ...(upload.code ? { code: upload.code } : {}) };
  if (upload?.state === "failed") {
    // 木村 #255 third round f: a definite Slack failure is more specific than the
    // generic not_sent marker, so (reconcile flag ON) the poll shows the same
    // record the re-run reads → the same reinvokeReason from the one builder.
    const definite = Boolean(upload.slackError) && isApprovalAttachmentReconcileEnabled();
    return (definite ? undefined : stored) ?? {
      status: "failed", ...display(upload), ...(upload.code ? { code: upload.code } : {}),
      ...(upload.slackError ? { slackError: upload.slackError } : {}),
      ...(upload.slackNeeded ? { slackNeeded: upload.slackNeeded } : {}),
      ...(upload.slackTokenType ? { slackTokenType: upload.slackTokenType } : {}),
    };
  }
  const legacy = obj(metadata?.attachmentFulfillment);
  if (legacy?.ok === true && str(legacy.fileId)) {
    const bytes = num(legacy.bytes);
    return { status: "sent", fileId: String(legacy.fileId), filename: str(legacy.filename) ?? "", ...(bytes !== undefined ? { bytes } : {}) };
  }
  return stored;
}

/** True when the approved attachment is already uploaded (claim record or #252 record). */
export function attachmentAlreadyUploaded(metadata: Record<string, unknown> | null | undefined): boolean {
  return liveFileUpload(metadata, undefined)?.status === "sent";
}

/**
 * Scheduled reconcile (#253 follow-up 1+2): change the record ONLY when it is
 * still exactly what the reconcile read (same state + same claimId). Returns
 * true for the single caller whose write was applied, false otherwise (state
 * moved on, a re-run took a new claim, already notified, or the store is
 * unavailable → nothing written, fail closed).
 *
 *   running|uncertain → succeeded (fileId required) | failed
 *   running|uncertain → uncertain: records adminNotifiedAt (+ recheckAttempts 0,
 *                       nextCheckAt); refused when it is already set, so the
 *                       admin agent is told once per claim
 *   uncertain (notified) → uncertain re-check (木村 2): only with
 *                       schedule.recheckAttempts = stored attempts + 1
 *                       (compare-and-set) and nextCheckAt within
 *                       adminNotifiedAt + 24 h; no nextCheckAt = stop
 *                       (recheckStoppedAt)
 *
 * Production: RPC reconcile_approval_attachment_upload (row lock), see
 * supabase/migrations/20261004400000_approval_attachment_reconcile.sql.
 */
export async function reconcileAttachmentUpload(
  approval: ApprovalRequest,
  expected: { state: "running" | "uncertain"; claimId?: string },
  state: Exclude<AttachmentUploadState, "running">,
  result: AttachmentUploadResult,
  opts: { schedule?: AttachmentRecheckSchedule; at?: Date } = {}
): Promise<boolean> {
  const picked = pickResult(result);
  if (state === "succeeded" && !picked.fileId) return false;
  const schedule = state === "uncertain" ? cleanSchedule(opts.schedule) : undefined;
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) return false;
    try {
      const { data, error } = await admin.rpc("reconcile_approval_attachment_upload", {
        p_id: approval.id, p_org: approval.orgId, p_expected_state: expected.state,
        p_expected_claim: expected.claimId ?? null, p_state: state, p_result: { ...picked, ...(schedule ?? {}) },
      });
      return !error && data === true;
    } catch {
      return false;
    }
  }
  const current = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  if (!current) return false;
  // ---- synchronous check-and-set (no await until the record is replaced) ----
  const key = `${approval.orgId}:${approval.id}`;
  const record = demoClaims.get(key) ?? readAttachmentUpload(current.metadata);
  if (!record || record.state !== expected.state || (record.claimId ?? null) !== (expected.claimId ?? null)) return false;
  const at = (opts.at ?? new Date()).toISOString();
  let next: AttachmentUploadRecord;
  if (state === "uncertain" && record.adminNotifiedAt) {
    // stopped (schedule ran out, or the A1 item was resolved): never re-scheduled
    if (record.recheckStoppedAt) return false;
    // re-check of a notified record: compare-and-set on the attempt count
    if (!schedule || schedule.recheckAttempts !== (record.recheckAttempts ?? 0) + 1) return false;
    if (schedule.nextCheckAt && !withinRecheckWindow(record.adminNotifiedAt, schedule.nextCheckAt)) return false;
    const rest: AttachmentUploadRecord = { ...record };
    delete rest.nextCheckAt;
    next = {
      ...rest, ...picked, reconciledAt: at, recheckAttempts: schedule.recheckAttempts,
      ...(schedule.nextCheckAt ? { nextCheckAt: schedule.nextCheckAt } : { recheckStoppedAt: at }),
    };
  } else {
    next = {
      ...record, ...picked, state, reconciledAt: at,
      ...(record.state === "running" ? { finishedAt: at } : {}),
      ...(state === "uncertain"
        ? { adminNotifiedAt: at, recheckAttempts: 0, ...(schedule?.nextCheckAt ? { nextCheckAt: schedule.nextCheckAt } : {}) }
        : {}),
    };
  }
  demoClaims.set(key, next);
  // ---------------------------------------------------------------------------
  await updateApprovalMetadata(current, { attachmentUpload: next }).catch(() => undefined);
  return true;
}

/**
 * 木村 #255 second round: stop the re-check schedule of a notified uncertain
 * record (A1 item resolved by the admin agent). Sets recheckStoppedAt +
 * recheckStopReason and removes nextCheckAt; the state is not changed (still
 * uncertain → a re-run never uploads). true only for the write that stopped it;
 * already stopped / not a notified uncertain record / store error → false.
 * Production: RPC stop_approval_attachment_recheck (row lock).
 */
export async function stopAttachmentRechecks(approval: ApprovalRequest, reason: RecheckStopReason): Promise<boolean> {
  if (!RECHECK_STOP_REASONS.includes(reason)) return false;
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) return false;
    try {
      const { data, error } = await admin.rpc("stop_approval_attachment_recheck", {
        p_id: approval.id, p_org: approval.orgId, p_reason: reason,
      });
      return !error && data === true;
    } catch {
      return false;
    }
  }
  const current = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  if (!current) return false;
  // ---- synchronous check-and-set ----
  const key = `${approval.orgId}:${approval.id}`;
  const record = demoClaims.get(key) ?? readAttachmentUpload(current.metadata);
  if (!record || record.state !== "uncertain" || !record.adminNotifiedAt || record.recheckStoppedAt) return false;
  const next: AttachmentUploadRecord = { ...record, recheckStoppedAt: new Date().toISOString(), recheckStopReason: reason };
  delete next.nextCheckAt;
  demoClaims.set(key, next);
  // -----------------------------------
  await updateApprovalMetadata(current, { attachmentUpload: next }).catch(() => undefined);
  return true;
}

function cleanSchedule(schedule: AttachmentRecheckSchedule | undefined): AttachmentRecheckSchedule | undefined {
  if (!schedule) return undefined;
  const { recheckAttempts, nextCheckAt } = schedule;
  if (!Number.isInteger(recheckAttempts) || recheckAttempts < 0 || recheckAttempts > MAX_RECHECK_ATTEMPTS) return undefined;
  const at = nextCheckAt !== undefined ? Date.parse(nextCheckAt) : NaN;
  return { recheckAttempts, ...(Number.isFinite(at) ? { nextCheckAt: new Date(at).toISOString() } : {}) };
}

function withinRecheckWindow(adminNotifiedAt: string, nextCheckAt: string): boolean {
  const t0 = Date.parse(adminNotifiedAt);
  const next = Date.parse(nextCheckAt);
  return Number.isFinite(t0) && Number.isFinite(next) && next > t0 && next <= t0 + ATTACHMENT_RECHECK_WINDOW_MS;
}

/**
 * Text posted, approved attachment present, and nothing says what happened to
 * it: no upload record, no #252 record, no stored fileUpload marker.
 */
export function needsAttachmentNotSentMarker(metadata: Record<string, unknown> | null | undefined): boolean {
  const fulfillment = obj(metadata?.fulfillment);
  if (!fulfillment || fulfillment.ok !== true || fulfillment.fileUpload !== undefined) return false;
  if (metadata?.attachmentUpload !== undefined) return false;
  if (obj(metadata?.attachmentFulfillment)?.ok === true) return false;
  return true;
}

const demoNotSentMarks = new Set<string>();

/**
 * Scheduled not_sent marking (#253 follow-up 6): writes
 * fulfillment.fileUpload = marker only while needsAttachmentNotSentMarker still
 * holds, so exactly one caller gets true (one audit). Production: RPC
 * mark_approval_attachment_not_sent (row lock). Errors → false (nothing written).
 */
export async function markAttachmentNotSent(
  approval: ApprovalRequest,
  marker: Extract<FulfillmentFileUpload, { status: "not_sent" }>
): Promise<boolean> {
  const clean = parseStoredFileUpload(marker);
  if (!clean) return false;
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) return false;
    try {
      const { data, error } = await admin.rpc("mark_approval_attachment_not_sent", {
        p_id: approval.id, p_org: approval.orgId, p_marker: clean,
      });
      return !error && data === true;
    } catch {
      return false;
    }
  }
  const current = await getApprovalById(approval.id, approval.orgId).catch(() => null);
  if (!current || current.status !== "approved") return false;
  // ---- synchronous check-and-set ----
  const key = `${approval.orgId}:${approval.id}`;
  if (demoNotSentMarks.has(key) || demoClaims.has(key) || !needsAttachmentNotSentMarker(current.metadata)) return false;
  demoNotSentMarks.add(key);
  // -----------------------------------
  const fulfillment = obj(current.metadata?.fulfillment) ?? {};
  await updateApprovalMetadata(current, { fulfillment: { ...fulfillment, fileUpload: clean } }).catch(() => undefined);
  return true;
}
