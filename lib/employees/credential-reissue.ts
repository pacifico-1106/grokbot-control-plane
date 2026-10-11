/**
 * Admin MCP employees.credential.reissue (ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED,
 * default OFF; 木村 2026-10-12, after every TOKYO307 社員証 expired).
 *
 * Flow — the key never reaches the AI and is never stored:
 *  1. propose (handleCredentialReissueTool): the admin AI files an always_human
 *     admin-class ticket {employeeId, reason}. Org from the admin credential
 *     only; another org's employee = employee_not_found; the admin agent cannot
 *     target the badge bound to its own Grok Bot. Approver class (#279):
 *     standard (owner or designated admin); the employee holds a money scope /
 *     scopes unreadable → owner (approver-authority/targets.ts).
 *  2. human approves (self-approval by the requesting admin agent is refused by
 *     resolveApproval). fulfil (fulfillCredentialReissue) re-checks the employee
 *     and only AUTHORIZES the hand-over: nothing is minted, no secret in the
 *     fulfillment, the AI's result carries a dashboard pointer only.
 *  3. hand-over (redeemCredentialReissue), the EXISTING dashboard path: a
 *     credential admin of the same org opens /app/employees/<id> and reissues
 *     (POST /api/employees/[id]/rotate with reissueApprovalId — same gate as
 *     rotate). The secret is minted there and shown once in that human's
 *     browser. Revoke-old-on-issue: the old 社員証 keeps working until this
 *     moment (no outage while waiting), and rotateCredential revokes it now.
 *     Single use, within CREDENTIAL_REISSUE_PICKUP_WINDOW_MS of approval; the
 *     ticket must be this tool's, this org's, this employee's, approved and
 *     fulfilled. Audit credential.rotated: ticket id + 12-char hash prefix.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { requesterOf, selfBound } from "@/lib/admin-mcp/allowed-accounts-tools";
import { rejectUnsafeArgs } from "@/lib/admin-mcp/slack-dm-setup";
import { mintOneTimeSecret } from "@/lib/bindings";
import { getApprovalById, listApprovals } from "@/lib/data/approvals";
import { claimCredentialReissueTicket, releaseCredentialReissueTicket } from "@/lib/data/credential-reissue-claims";
import { randomBytes } from "node:crypto";
import { appendAuditEvent } from "@/lib/data/audit";
import { getBinding, rotateCredential } from "@/lib/data/bindings";
import { getEmployee } from "@/lib/data/employees";
import { credentialExpiry, formatCredentialExpiryJa } from "@/lib/employees/credential-expiry";
import { isAdminMcpCredentialReissueEnabled } from "@/lib/feature-flags";
import type { ApprovalRequest, EmployeeBinding } from "@/lib/types";

export const CREDENTIAL_REISSUE_TOOL = "employees.credential.reissue" as const;
export const CREDENTIAL_REISSUE_ALLOWED_ARGS = ["employeeId", "reason", "jobId", "approvalId"] as const;
export const CREDENTIAL_REISSUE_REASONS = ["expired", "expiring", "other"] as const;
export type CredentialReissueReason = (typeof CREDENTIAL_REISSUE_REASONS)[number];
export const CREDENTIAL_REISSUE_PICKUP_WINDOW_MS = 24 * 3_600_000;

const REASON_JA: Record<CredentialReissueReason, string> = { expired: "期限切れ", expiring: "期限間近", other: "その他" };
const FLAG_OFF = { code: "feature_disabled", message: "社員証の再発行ツールは無効です（ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED）。ダッシュボードの AI社員ページから再発行してください。" } as const;
const NOT_FOUND = { code: "employee_not_found", message: "AI社員が見つかりません" } as const;

export type CredentialReissueToolOutcome =
  | { kind: "result"; data: Record<string, unknown>; isError?: boolean }
  | { kind: "queue"; title: string; queuedArgs: Record<string, unknown>; summary: string };

const fail = (code: string, message: string, extra: Record<string, unknown> = {}): CredentialReissueToolOutcome => ({
  kind: "result",
  isError: true,
  data: { ok: false, code, error: code, message, ...extra },
});

function dashboardPath(employeeId: string): string {
  return `/app/employees/${encodeURIComponent(employeeId)}`;
}

function handoverJa(employeeId: string): string {
  return (
    `鍵は AI には渡しません。credential 管理権限のある人がダッシュボード ${dashboardPath(employeeId)} を開き、` +
    `「承認済みの社員証再発行を受け取る」で新しい社員証を一度だけ表示して受け取ります（承認から24時間以内）。` +
    `受け取った時点で古い社員証は失効します。新しい社員証を Grok Bot の MCP 設定に入れるのは人が行います（チャットに貼らない）。`
  );
}

export function parseReissueReason(value: unknown): CredentialReissueReason | null {
  if (value === undefined || value === null || value === "") return "other";
  return typeof value === "string" && (CREDENTIAL_REISSUE_REASONS as readonly string[]).includes(value) ? (value as CredentialReissueReason) : null;
}

// ---------------------------------------------------------------------------
// 1. propose
// ---------------------------------------------------------------------------

export async function handleCredentialReissueTool(
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<CredentialReissueToolOutcome> {
  if (!isAdminMcpCredentialReissueEnabled()) return fail(FLAG_OFF.code, FLAG_OFF.message);
  const unsafe = rejectUnsafeArgs(args, CREDENTIAL_REISSUE_ALLOWED_ARGS);
  if (unsafe) return unsafe as CredentialReissueToolOutcome;
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  if (!employeeId) return fail("missing_required_fields", "employeeId が必要です");
  const reason = parseReissueReason(args.reason);
  if (!reason) return fail("invalid_reason", `reason は ${CREDENTIAL_REISSUE_REASONS.join(" | ")} のいずれかです`);

  const employee = await getEmployee(employeeId, cred.orgId);
  if (!employee || employee.orgId !== cred.orgId) return fail(NOT_FOUND.code, NOT_FOUND.message);
  if (employee.status === "suspended") return fail("employee_terminated", "この AI 社員は停止されています。");
  const binding = await getBinding(employee.id);
  if (binding?.status === "revoked") return fail("revoked", "取り消された連携の社員証は再発行できません。");
  if (selfBound(cred.grokBotAgentId, binding?.grokBotAgentId)) {
    return fail("cannot_target_self", "管理エージェントは自分の社員証を再発行できません。");
  }
  const expiry = credentialExpiry(employee);
  const current =
    expiry.state === "none" ? "社員証なし" : `現在の期限 ${formatCredentialExpiryJa(expiry.expiresAt)}${expiry.state === "expired" ? "（期限切れ）" : ""}`;
  return {
    kind: "queue",
    title: "AI社員の社員証の再発行",
    queuedArgs: { employeeId: employee.id, reason },
    summary:
      `AI社員 ${employee.id} の社員証を再発行します（理由: ${REASON_JA[reason]}、${current}）。` +
      `承認しても鍵は AI に返さず、ダッシュボードで人が一度だけ受け取ります。受け取った時点で古い社員証は失効します。`,
  };
}

// ---------------------------------------------------------------------------
// 2. fulfil (human approved): authorize the hand-over only
// ---------------------------------------------------------------------------

export type CredentialReissueFulfillment =
  | { ok: true; employeeId: string; summaryJa: string; nextStepJa: string }
  | { ok: false; code: string; messageJa: string; employeeId?: string };

export async function fulfillCredentialReissue(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<CredentialReissueFulfillment> {
  const orgId = approval.orgId;
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  const audit = async (event: string, extra: Record<string, unknown>) =>
    appendAuditEvent({
      orgId,
      employeeId: employeeId || null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: event === "employee.credential.reissue_approved" ? "社員証の再発行を承認（受け取りはダッシュボード）" : `社員証の再発行を中止（${String(extra.code)}）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        event,
        tool: CREDENTIAL_REISSUE_TOOL,
        approvalId: approval.id,
        employeeId: employeeId || null,
        reason: parseReissueReason(args.reason) ?? "other",
        actor: requesterOf(approval),
        approver: approval.resolvedBy ?? null,
        ...extra,
      },
    }).catch(() => undefined);
  const stop = async (code: string, messageJa: string): Promise<CredentialReissueFulfillment> => {
    await audit("employee.credential.reissue_rejected", { code });
    return { ok: false, code, messageJa, ...(employeeId ? { employeeId } : {}) };
  };
  if (!isAdminMcpCredentialReissueEnabled()) return stop(FLAG_OFF.code, FLAG_OFF.message);
  if (!employeeId) return stop("invalid_payload", "employeeId がありません");
  const employee = await getEmployee(employeeId, orgId);
  if (!employee || employee.orgId !== orgId) return stop(NOT_FOUND.code, NOT_FOUND.message);
  if (employee.status === "suspended") return stop("employee_terminated", "この AI 社員は停止されています。");
  const binding = await getBinding(employee.id);
  if (binding?.status === "revoked") return stop("revoked", "取り消された連携の社員証は再発行できません。");
  await audit("employee.credential.reissue_approved", {});
  return {
    ok: true,
    employeeId,
    summaryJa: `AI社員 ${employeeId} の社員証の再発行が承認されました（まだ発行していません）。`,
    nextStepJa: handoverJa(employeeId),
  };
}

// ---------------------------------------------------------------------------
// 3. hand-over at the dashboard
// ---------------------------------------------------------------------------

type ReissueRecord = { redeemedAt?: string; redeemedByMemberId?: string | null };

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function toolOf(a: ApprovalRequest): string {
  return String(a.metadata?.adminTool || a.tool || "");
}
function employeeOf(a: ApprovalRequest): string {
  const id = rec(a.metadata?.adminMutation).employeeId;
  return typeof id === "string" ? id.trim() : "";
}
function fulfilledOk(a: ApprovalRequest): boolean {
  const f = rec(a.metadata?.adminFulfillment ?? a.metadata?.fulfillment);
  return f.ok === true && f.tool === CREDENTIAL_REISSUE_TOOL;
}
function approvedAtMs(a: ApprovalRequest): number {
  const f = rec(a.metadata?.adminFulfillment ?? a.metadata?.fulfillment);
  const raw = a.resolvedAt || (typeof f.at === "string" ? f.at : "");
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Number.NaN;
}
function reissueRecord(a: ApprovalRequest): ReissueRecord {
  return rec(a.metadata?.credentialReissue) as ReissueRecord;
}

export interface PendingCredentialReissue {
  approvalId: string;
  approvedAt: string;
  pickupUntil: string;
}

/** Newest approved, fulfilled, unredeemed reissue ticket of this org × employee inside the window. */
export async function findPendingCredentialReissue(
  orgId: string,
  employeeId: string,
  now: Date = new Date()
): Promise<PendingCredentialReissue | null> {
  if (!isAdminMcpCredentialReissueEnabled() || !orgId || !employeeId) return null;
  const rows = (await listApprovals(orgId).catch(() => [] as ApprovalRequest[])).filter(
    (a) =>
      a.orgId === orgId &&
      a.status === "approved" &&
      toolOf(a) === CREDENTIAL_REISSUE_TOOL &&
      employeeOf(a) === employeeId &&
      fulfilledOk(a) &&
      !reissueRecord(a).redeemedAt &&
      now.getTime() <= approvedAtMs(a) + CREDENTIAL_REISSUE_PICKUP_WINDOW_MS
  );
  rows.sort((x, y) => approvedAtMs(y) - approvedAtMs(x));
  const a = rows[0];
  if (!a) return null;
  const at = approvedAtMs(a);
  return { approvalId: a.id, approvedAt: new Date(at).toISOString(), pickupUntil: new Date(at + CREDENTIAL_REISSUE_PICKUP_WINDOW_MS).toISOString() };
}

export type RedeemCredentialReissueResult =
  | { ok: true; secret: { raw: string; prefix: string; fingerprint: string }; generation: number; binding: EmployeeBinding }
  | { ok: false; code: string; messageJa: string };

const REFUSE: Record<string, string> = {
  feature_disabled: FLAG_OFF.message,
  reissue_approval_not_found: "承認済みの再発行チケットが見つかりません。",
  reissue_approval_mismatch: "このチケットはこの AI社員の社員証再発行ではありません。",
  reissue_approval_not_approved: "このチケットはまだ承認されていません。",
  reissue_approval_used: "このチケットの社員証は受け取り済みです。もう一度必要なら、新しく依頼してください。",
  reissue_approval_expired: "受け取り期限（承認から24時間）を過ぎました。もう一度依頼してください。",
  employee_terminated: "この AI 社員は停止されています。",
  revoked: "取り消された連携の社員証は再発行できません。",
  reissue_claim_failed: "受け取りの記録に失敗しました。もう一度お試しください。",
  rotate_failed: "再発行に失敗しました。",
};
const refuse = (code: keyof typeof REFUSE): RedeemCredentialReissueResult => ({ ok: false, code, messageJa: REFUSE[code] });

export async function redeemCredentialReissue(input: {
  orgId: string;
  employeeId: string;
  approvalId: string;
  actor: { memberId: string; email: string | null };
  now?: Date;
}): Promise<RedeemCredentialReissueResult> {
  if (!isAdminMcpCredentialReissueEnabled()) return refuse("feature_disabled");
  const now = input.now ?? new Date();
  const orgId = (input.orgId || "").trim();
  const employeeId = (input.employeeId || "").trim();
  const approvalId = (input.approvalId || "").trim();
  if (!orgId || !employeeId || !approvalId) return refuse("reissue_approval_not_found");
  const approval = await getApprovalById(approvalId, orgId).catch(() => null);
  if (!approval || approval.orgId !== orgId) return refuse("reissue_approval_not_found");
  if (toolOf(approval) !== CREDENTIAL_REISSUE_TOOL || employeeOf(approval) !== employeeId) return refuse("reissue_approval_mismatch");
  if (approval.status !== "approved" || !fulfilledOk(approval)) return refuse("reissue_approval_not_approved");
  if (reissueRecord(approval).redeemedAt) return refuse("reissue_approval_used");
  const at = approvedAtMs(approval);
  if (!Number.isFinite(at) || now.getTime() > at + CREDENTIAL_REISSUE_PICKUP_WINDOW_MS) return refuse("reissue_approval_expired");
  const employee = await getEmployee(employeeId, orgId);
  if (!employee || employee.orgId !== orgId) return refuse("reissue_approval_not_found");
  if (employee.status === "suspended") return refuse("employee_terminated");

  // Claim the ticket before minting (single use), atomically: one conditional
  // UPDATE (public.claim_credential_reissue, migration 20261012200000) sets the
  // mark only while unclaimed → of concurrent pickups exactly one proceeds.
  const claimToken = randomBytes(18).toString("base64url");
  let claimed: boolean;
  try {
    claimed = await claimCredentialReissueTicket({
      approvalId: approval.id,
      orgId,
      token: claimToken,
      memberId: input.actor.memberId || null,
      at: now.toISOString(),
    });
  } catch {
    return refuse("reissue_claim_failed");
  }
  if (!claimed) return refuse("reissue_approval_used");

  const secret = mintOneTimeSecret();
  let rotated: { binding: EmployeeBinding; generation: number };
  try {
    // Same call as POST rotate: new credentials row with the employee's current
    // policy; every other live row of this employee is revoked (revoke-old-on-issue).
    rotated = await rotateCredential(employeeId, orgId, secret.fingerprint, {
      secretPrefix: secret.prefix,
      scopes: employee.scopes,
      allowedPurposes: employee.allowedPurposes,
      approvalPolicy: employee.approvalPolicy,
      actionLimits: employee.actionLimits,
      spend: employee.spend,
      allowedAccounts: employee.allowedAccounts,
    });
  } catch (e) {
    // Nothing was issued: reopen the ticket so it can be retried in the window —
    // releasing only OUR mark (same claim token), never someone else's.
    await releaseCredentialReissueTicket({ approvalId: approval.id, orgId, token: claimToken }).catch(() => false);
    return refuse((e as { code?: string }).code === "revoked" ? "revoked" : "rotate_failed");
  }
  await appendAuditEvent({
    orgId,
    employeeId,
    credentialId: employee.credentialId ?? null,
    actorEmail: input.actor.email ?? undefined,
    action: "credential.rotated",
    purpose: null,
    summary: `${employee.displayName} の社員証を再発行（管理MCPの承認済み依頼・世代 ${rotated.generation}）`,
    metadata: {
      generation: rotated.generation,
      secretHashPrefix: secret.fingerprint.slice(0, 12),
      actorMemberId: input.actor.memberId,
      reissueApprovalId: approval.id,
      tool: CREDENTIAL_REISSUE_TOOL,
    },
  }).catch(() => undefined);
  return { ok: true, secret: { raw: secret.raw, prefix: secret.prefix, fingerprint: secret.fingerprint }, generation: rotated.generation, binding: rotated.binding };
}
