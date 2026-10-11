/**
 * AI安全5ルール #3 緊急停止 — S3: start / request-release / release (design §2.4, §2.6).
 *
 * Who may act (decision points 1, 2, 8):
 * - Only a HUMAN actor: a signed-in org member (web or an inbox button bound to a member),
 *   or an ops-console super admin. There is no actor type for an AI credential; every route
 *   refuses AI bearers before it builds an actor (`hold-route.ts › refuseAiCredential`).
 * - Stop an employee: owner / admin / a member with approve_actions. Stop the org: owner.
 * - Release: web only (HOLD_RELEASE_SURFACES), fresh login ≤ 5 min, approved by an owner or
 *   designated admin who is NOT the requester (single-owner exception per S1, never for
 *   detector holds). An ops-console hold is never released here (S4, two ops people).
 * - The S1 SQL functions re-check all of this; this layer gives early, clear refusals.
 *
 * A stop never fails silently (木村 10/12 05:35): 40P01 / 40001 are retried; if the stop still
 * fails — or fails for any unexpected reason — ops are alerted and the caller gets a 503.
 */
import type { OrgMember } from "@/lib/types";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { appendAuditEvent } from "@/lib/data/audit";
import { createApproval, getApprovalById } from "@/lib/data/approvals";
import { demoGetApproval, demoUpdateApproval } from "@/lib/data/demo-approvals-store";
import { getEmployee } from "@/lib/data/employees";
import { listMembers } from "@/lib/data/members";
import { getDesignatedAdminMemberIds } from "@/lib/approver-authority/designated-admins";
import { hasCapability } from "@/lib/team/rbac";
import {
  HOLD_RELEASE_SURFACES,
  HOLD_RELEASE_TOOL,
  HOLD_START_BACKOFF_MS,
  HOLD_START_MAX_ATTEMPTS,
  HOLD_START_RETRYABLE_CODES,
  isEmployeeHoldEnabled,
  isOrgHoldEnabled,
} from "@/lib/safety/hold-config";
import { getHoldStore, HoldStoreError, type HoldRecord } from "@/lib/safety/hold-store";
import { verifyReleaseAuthentication } from "@/lib/safety/hold-release-auth";
import { notifyHold } from "@/lib/safety/hold-notify";

export type HoldMemberSurface = "web" | "slack" | "line" | "telegram";
export type HoldActor =
  | { type: "member"; member: OrgMember; surface: HoldMemberSurface; lastSignInAt?: string | null }
  | { type: "ops"; opsId: string; surface: "ops_console" };

export type HoldFailure = { ok: false; code: string; httpStatus: number; message?: string };
export type StartHoldResult = { ok: true; holdId: string; created: boolean; upgraded: boolean; attempts: number } | HoldFailure;

const fail = (code: string, httpStatus: number, message?: string): HoldFailure => ({ ok: false, code, httpStatus, ...(message ? { message } : {}) });

const OPS_ID_RE = /^[A-Za-z0-9._@+-]{1,128}$/;
const REASON_MAX = 500;

let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
/** Tests only. */
export function __setHoldSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

/** Runtime check too: only the two human actor shapes are accepted (no AI / system actor). */
function humanActor(actor: unknown): actor is HoldActor {
  const a = actor as HoldActor | null;
  if (!a || typeof a !== "object") return false;
  if (a.type === "ops") return a.surface === "ops_console" && OPS_ID_RE.test(String(a.opsId ?? ""));
  if (a.type === "member") {
    return ["web", "slack", "line", "telegram"].includes(a.surface) && Boolean(a.member?.id) && a.member.status === "active";
  }
  return false;
}

export function canStopEmployee(member: OrgMember): boolean {
  return member.status === "active" && (member.role === "owner" || member.role === "admin" || hasCapability(member, "approve_actions"));
}
export function canStopOrg(member: OrgMember): boolean {
  return member.status === "active" && member.role === "owner";
}

function startedByOf(actor: HoldActor): string {
  return actor.type === "ops" ? `ops:${actor.opsId}` : `member:${actor.member.id}`;
}

function cleanReason(reason: unknown): string | null {
  const s = typeof reason === "string" ? Array.from(reason.trim()).slice(0, REASON_MAX).join("") : "";
  return s || null;
}

/** Release surfaces + freshness: delegated to the ONE swappable function (passkey later). */
function assertReleaseSurface(actor: HoldActor, now: Date): HoldFailure | null {
  if (actor.type !== "member") return fail("ops_hold_release_is_s4", 403);
  const v = verifyReleaseAuthentication({ surface: actor.surface, lastSignInAt: actor.lastSignInAt ?? null }, now);
  return v.ok ? null : fail(v.code, v.httpStatus, v.message);
}

function retryable(error: unknown): string | null {
  const state = error instanceof HoldStoreError ? error.sqlState : (error as { code?: string } | null)?.code ?? null;
  return state && HOLD_START_RETRYABLE_CODES.has(state) ? state : null;
}

// ---------------------------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------------------------
export async function startHold(input: {
  orgId: string;
  employeeId: string | null;
  reason?: string | null;
  actor: HoldActor;
}): Promise<StartHoldResult> {
  if (!humanActor(input.actor)) return fail("ai_cannot_hold", 403);
  if (!isEmployeeHoldEnabled()) return fail("hold_disabled", 404);
  const actor = input.actor;
  if (!input.orgId) return fail("org_required", 400);
  if (input.employeeId === null) {
    if (!isOrgHoldEnabled()) return fail("org_hold_disabled", 404);
    if (actor.type === "member" && !canStopOrg(actor.member)) return fail("forbidden", 403, "組織全体の停止はオーナーのみです。");
  } else {
    if (actor.type === "member" && !canStopEmployee(actor.member)) return fail("forbidden", 403);
    // Terminated (suspended) employees can still be stopped (leaked-key incidents, decoys).
    const employee = await getEmployee(input.employeeId, input.orgId).catch(() => null);
    if (!employee || employee.orgId !== input.orgId) return fail("employee_not_found", 404);
  }
  if (actor.type === "member" && actor.member.orgId !== input.orgId) return fail("forbidden", 403);

  const store = getHoldStore();
  const startInput = {
    orgId: input.orgId, employeeId: input.employeeId, kind: "stopped" as const, reason: cleanReason(input.reason),
    startedBy: startedByOf(actor), startedVia: actor.surface, trigger: null,
  };
  let attempts = 0;
  let lastError: unknown = null;
  while (attempts < HOLD_START_MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const out = await store.start(startInput);
      await appendAuditEvent({
        orgId: input.orgId, employeeId: input.employeeId, credentialId: null, action: "employee.hold.started",
        purpose: "employee.hold.started",
        summary: out.created ? "緊急停止しました" : out.upgraded ? "緊急停止をより強い停止に切り替えました" : "すでに停止中です（既存の停止を維持）",
        actorEmail: actor.type === "member" ? actor.member.email : actor.opsId,
        metadata: { auditClass: "admin", holdId: out.holdId, created: out.created, upgraded: out.upgraded, via: actor.surface,
          startedBy: startInput.startedBy, scope: input.employeeId ? "employee" : "org", attempts, heldTickets: out.heldTickets },
      }).catch(() => undefined);
      if (out.created || out.upgraded) {
        await notifyHold({ event: out.upgraded ? "hold.upgraded" : "hold.started", orgId: input.orgId, employeeId: input.employeeId,
          holdId: out.holdId, kind: "stopped", via: actor.surface }, { tenant: true, ops: actor.type === "ops" || input.employeeId === null });
      }
      return { ok: true, holdId: out.holdId, created: out.created, upgraded: out.upgraded, attempts };
    } catch (error) {
      lastError = error;
      // Refusals from S1 (employee_not_found …) are answers, not failures.
      if (error instanceof HoldStoreError && error.code !== "hold_store_failed" && error.code !== "supabase_not_configured") {
        return fail(error.code, error.code.endsWith("_not_found") ? 404 : 409);
      }
      if (!retryable(error) || attempts >= HOLD_START_MAX_ATTEMPTS) break;
      await sleepImpl(HOLD_START_BACKOFF_MS[Math.min(attempts - 1, HOLD_START_BACKOFF_MS.length - 1)]);
    }
  }
  // Never silent: alert ops (ids / sqlstate only) and tell the caller it did NOT stop.
  const sqlState = retryable(lastError) ?? (lastError instanceof HoldStoreError ? lastError.sqlState : null);
  console.error("employee_hold_start_failed", { orgId: input.orgId, employeeId: input.employeeId, attempts, sqlState });
  await appendAuditEvent({
    orgId: input.orgId, employeeId: input.employeeId, credentialId: null, action: "employee.hold.start_failed",
    purpose: "employee.hold.start_failed", summary: "緊急停止に失敗しました（運営に通知済み）",
    metadata: { auditClass: "admin", via: actor.surface, startedBy: startInput.startedBy, attempts, sqlState },
  }).catch(() => undefined);
  await notifyHold({ event: "hold.start_failed", orgId: input.orgId, employeeId: input.employeeId, holdId: null,
    via: actor.surface, sqlState, attempts }, { ops: true, tenant: true });
  return fail("hold_start_failed", 503, "停止できませんでした。運営に通知しました。もう一度押すか、社員証の失効も行ってください。");
}

// ---------------------------------------------------------------------------------------------
// Release: request (web, fresh login) → approve (web, fresh login, different person) → release
// ---------------------------------------------------------------------------------------------
async function eligibleApproverIds(orgId: string): Promise<string[]> {
  const [members, designated] = await Promise.all([listMembers(orgId), getDesignatedAdminMemberIds(orgId)]);
  return members.filter((m) => m.status === "active" && (m.role === "owner" || designated.includes(m.id))).map((m) => m.id);
}

async function expireTicket(orgId: string, id: string): Promise<void> {
  if (isDemoMode()) {
    const t = await demoGetApproval(id);
    if (t && t.orgId === orgId && t.status === "pending") await demoUpdateApproval(id, { status: "expired" as never });
    return;
  }
  const admin = createSupabaseAdminClient();
  await admin?.from("approval_requests").update({ status: "expired" }).eq("id", id).eq("org_id", orgId).eq("status", "pending");
}

async function setTicketDecision(orgId: string, id: string, from: "pending" | "approved", to: "approved" | "pending",
  memberId: string, patch: Record<string, unknown>): Promise<boolean> {
  const resolvedAt = to === "approved" ? new Date().toISOString() : null;
  if (isDemoMode()) {
    const t = await demoGetApproval(id);
    if (!t || t.orgId !== orgId || t.status !== from) return false;
    if (from === "approved" && t.resolvedBy !== memberId) return false;
    await demoUpdateApproval(id, { status: to as never, resolvedBy: to === "approved" ? memberId : undefined, resolvedAt: resolvedAt ?? undefined,
      metadata: { ...t.metadata, ...patch } });
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const current = await getApprovalById(id, orgId);
  if (!current || current.status !== from) return false;
  let q = admin.from("approval_requests")
    .update({ status: to, resolved_by: to === "approved" ? memberId : null, resolved_at: resolvedAt, metadata: { ...current.metadata, ...patch } })
    .eq("id", id).eq("org_id", orgId).eq("status", from);
  if (from === "approved") q = q.eq("resolved_by", memberId);
  const { data, error } = await q.select("id");
  return !error && Array.isArray(data) && data.length === 1;
}

export type ReleaseRequestResult = { ok: true; approvalId: string; singleOwnerSelfRelease: boolean } | HoldFailure;

export async function requestHoldRelease(input: {
  orgId: string;
  holdId: string;
  reason: string;
  actor: HoldActor;
  now?: Date;
}): Promise<ReleaseRequestResult> {
  if (!humanActor(input.actor)) return fail("ai_cannot_hold", 403);
  if (!isEmployeeHoldEnabled()) return fail("hold_disabled", 404);
  const now = input.now ?? new Date();
  const surfaceFail = assertReleaseSurface(input.actor, now);
  if (surfaceFail) return surfaceFail;
  const actor = input.actor as Extract<HoldActor, { type: "member" }>;
  if (actor.member.orgId !== input.orgId || !canStopEmployee(actor.member)) return fail("forbidden", 403);
  const reason = cleanReason(input.reason);
  if (!reason) return fail("release_reason_required", 400, "解除の理由を書いてください。");
  const store = getHoldStore();
  const hold = await store.getHold(input.orgId, input.holdId);
  if (!hold) return fail("hold_not_found", 404);
  if (hold.startedVia === "ops_console" || hold.startedBy.startsWith("ops:")) return fail("ops_hold_ops_only", 403, "運営が止めた停止は運営のみが解除できます。");
  if (hold.employeeId === null && !canStopOrg(actor.member)) return fail("forbidden", 403);

  const requestedBy = `member:${actor.member.id}`;
  const approvers = await eligibleApproverIds(input.orgId);
  const detector = hold.kind === "quarantined" || hold.startedVia === "anomaly" || Boolean(hold.trigger);
  const singleOwnerSelfRelease = !detector && approvers.length === 1 && approvers[0] === actor.member.id;
  const created = await createApproval({
    orgId: input.orgId, employeeId: "", credentialId: "",
    title: hold.employeeId ? "緊急停止の解除（AI社員）" : "緊急停止の解除（組織全体）",
    purpose: "employee.hold.release",
    summary: `緊急停止の解除申請: ${hold.employeeId ? `AI社員 ${hold.employeeId}` : "組織全体"}（停止ID ${hold.id}）`,
    risk: "high", tool: HOLD_RELEASE_TOOL,
    metadata: {
      auditClass: "admin", approvalClass: "admin", always_human: true, adminTool: HOLD_RELEASE_TOOL,
      holdId: hold.id, holdEmployeeId: hold.employeeId, holdKind: hold.kind,
      requestedBy, requesterMemberId: actor.member.id, requesterIdentity: requestedBy,
      releaseSurfaces: [...HOLD_RELEASE_SURFACES], requestedVia: actor.surface,
      ...(singleOwnerSelfRelease ? { singleOwnerSelfRelease: true } : {}),
    },
  });
  try {
    await store.requestRelease({ orgId: input.orgId, holdId: hold.id, requestedBy, reason, approvalId: created.approval.id });
  } catch (error) {
    await expireTicket(input.orgId, created.approval.id).catch(() => undefined);
    const code = error instanceof HoldStoreError ? error.code : "hold_store_failed";
    return fail(code, code === "hold_store_failed" ? 503 : code === "hold_not_found" ? 404 : 409);
  }
  await appendAuditEvent({
    orgId: input.orgId, employeeId: hold.employeeId, credentialId: null, action: "employee.hold.release_requested",
    purpose: "employee.hold.release_requested", summary: "緊急停止の解除申請", actorEmail: actor.member.email,
    metadata: { auditClass: "admin", holdId: hold.id, approvalId: created.approval.id, requestedBy, via: actor.surface, singleOwnerSelfRelease },
  }).catch(() => undefined);
  // Text notice with a dashboard link only — never an approval card (inbox buttons only stop).
  await notifyHold({ event: "hold.release_requested", orgId: input.orgId, employeeId: hold.employeeId, holdId: hold.id, kind: hold.kind }, { tenant: true });
  return { ok: true, approvalId: created.approval.id, singleOwnerSelfRelease };
}

export type ReleaseResult = { ok: true; holdId: string; closedTickets: number } | HoldFailure;

const RELEASE_REFUSAL_STATUS: Record<string, number> = {
  hold_not_found: 404, ops_hold_ops_only: 403, release_approver_not_allowed: 403, release_requester_invalid: 403,
  release_not_requested: 409, release_not_approved: 409, release_ticket_invalid: 409,
};

export async function approveHoldRelease(input: {
  orgId: string;
  holdId: string;
  actor: HoldActor;
  now?: Date;
}): Promise<ReleaseResult> {
  if (!humanActor(input.actor)) return fail("ai_cannot_hold", 403);
  if (!isEmployeeHoldEnabled()) return fail("hold_disabled", 404);
  const now = input.now ?? new Date();
  const surfaceFail = assertReleaseSurface(input.actor, now);
  if (surfaceFail) return surfaceFail;
  const actor = input.actor as Extract<HoldActor, { type: "member" }>;
  if (actor.member.orgId !== input.orgId) return fail("forbidden", 403);
  const store = getHoldStore();
  const hold: HoldRecord | null = await store.getHold(input.orgId, input.holdId);
  if (!hold) return fail("hold_not_found", 404);
  if (hold.startedVia === "ops_console" || hold.startedBy.startsWith("ops:")) return fail("ops_hold_ops_only", 403);
  if (!hold.releaseApprovalId || !hold.releaseRequestedBy) return fail("release_not_requested", 409);
  const ticket = await getApprovalById(hold.releaseApprovalId, input.orgId);
  if (!ticket || ticket.orgId !== input.orgId) return fail("release_ticket_invalid", 409);
  const approvers = await eligibleApproverIds(input.orgId);
  if (!approvers.includes(actor.member.id)) return fail("release_approver_not_allowed", 403, "解除の承認はオーナーか指定管理者のみです。");
  const me = `member:${actor.member.id}`;
  if (me === hold.releaseRequestedBy && ticket.metadata?.singleOwnerSelfRelease !== true) {
    return fail("self_approval_denied", 403, "申請した本人は承認できません。別の人が承認してください。");
  }
  const patch = { releaseApprovedVia: actor.surface, releaseApprovedAt: now.toISOString(), releaseApproverMemberId: actor.member.id };
  const resumed = ticket.status === "approved" && ticket.resolvedBy === actor.member.id && ticket.metadata?.releaseApprovedVia === actor.surface;
  if (!resumed) {
    if (ticket.status !== "pending") return fail("release_ticket_invalid", 409);
    if (!(await setTicketDecision(input.orgId, ticket.id, "pending", "approved", actor.member.id, patch))) return fail("release_ticket_invalid", 409);
  }
  try {
    const out = await store.release({
      orgId: input.orgId, holdId: hold.id, auditSummary: "緊急停止を解除しました",
      auditMetadata: { via: actor.surface, approverEmail: actor.member.email, freshLogin: true },
    });
    await notifyHold({ event: "hold.released", orgId: input.orgId, employeeId: hold.employeeId, holdId: hold.id, kind: hold.kind }, { tenant: true, ops: hold.employeeId === null });
    return { ok: true, holdId: hold.id, closedTickets: out.closedTickets };
  } catch (error) {
    // Not lifted (S1: audit + release are one transaction). Put the ticket back so it can be retried.
    await setTicketDecision(input.orgId, ticket.id, "approved", "pending", actor.member.id, { releaseApprovedVia: null }).catch(() => false);
    const code = error instanceof HoldStoreError ? error.code : "hold_store_failed";
    await appendAuditEvent({
      orgId: input.orgId, employeeId: hold.employeeId, credentialId: null, action: "employee.hold.release_refused",
      purpose: "employee.hold.release_refused", summary: "緊急停止の解除は行われませんでした", actorEmail: actor.member.email,
      metadata: { auditClass: "admin", holdId: hold.id, approvalId: ticket.id, code },
    }).catch(() => undefined);
    return fail(code, RELEASE_REFUSAL_STATUS[code] ?? 503);
  }
}

/** UI read: the open hold (if any) for an employee or the org. Fails closed to "unknown". */
export async function readHoldForDisplay(orgId: string, employeeId: string | null): Promise<
  { state: "none" } | { state: "held"; hold: HoldRecord } | { state: "unknown" }
> {
  try {
    const hold = await getHoldStore().getOpenHold(orgId, employeeId);
    return hold ? { state: "held", hold } : { state: "none" };
  } catch {
    return { state: "unknown" };
  }
}
