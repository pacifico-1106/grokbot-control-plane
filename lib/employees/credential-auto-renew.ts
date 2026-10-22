/**
 * 社員証 auto-renew (R1 flags + R-now 今すぐ更新 + R3 overlap helpers).
 * Default OFF, fail-closed. gen1 HTTP is R8 (separate flag). No boot script.
 *
 * Org UUIDs belong in CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST only — never in code.
 * Never log or return 社員証 secret, prefix, hash, public key, or claim_token.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { requesterOf, selfBound } from "@/lib/admin-mcp/allowed-accounts-tools";
import { rejectUnsafeArgs } from "@/lib/admin-mcp/slack-dm-setup";
import { approverFilingStop } from "@/lib/approver-authority/filing";
import { createApproval, getApprovalById } from "@/lib/data";
import { adminAuditReason, appendAdminClassAuditEvent } from "@/lib/audit/admin-audit";
import { getBinding } from "@/lib/data/bindings";
import {
  expireStaleCredentialRenewalRows,
  findOpenCredentialRenewalRow,
  insertOrReuseCredentialRenewal,
  listPendingApprovalCredentialRenewals,
  markCredentialRenewalClaimable,
  markCredentialRenewalClosed,
  type CredentialRenewalRow,
} from "@/lib/data/credential-renewals";
import { getEmployee } from "@/lib/data/employees";
import { isUuid } from "@/lib/data/members";
import { credentialExpiry } from "@/lib/employees/credential-expiry";
import { maskEmail } from "@/lib/audit/mask";
import {
  isAdminAuditSixFieldWriteEnabledForOrg,
  isCredentialAutoRenewEnabled,
  isCredentialAutoRenewOrgAllowlistRequired,
} from "@/lib/feature-flags";

export { isCredentialAutoRenewEnabled };
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { checkOperable } from "@/lib/safety/hold";
import type { ApprovalRequest } from "@/lib/types";

export const CREDENTIAL_AUTO_RENEW_ADMIN_TOOL = "employees.credential.auto_renew" as const;

export const CREDENTIAL_AUTO_RENEW_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const CREDENTIAL_AUTO_RENEW_THRESHOLDS = ["7d", "now"] as const;
export type CredentialAutoRenewThreshold = (typeof CREDENTIAL_AUTO_RENEW_THRESHOLDS)[number];

export const CREDENTIAL_AUTO_RENEW_MODES = ["gen2", "gen1_http"] as const;
export type CredentialAutoRenewMode = (typeof CREDENTIAL_AUTO_RENEW_MODES)[number];

export const CREDENTIAL_AUTO_RENEW_STATES = [
  "pending_approval",
  "claimable",
  "claimed",
  "old_revoked",
  "rejected",
  "expired",
  "held_blocked",
] as const;
export type CredentialAutoRenewState = (typeof CREDENTIAL_AUTO_RENEW_STATES)[number];

function allowlistEntries(): string[] | null {
  const raw = process.env.CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST;
  const list = (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.some((id) => !isUuid(id))) return null;
  return list;
}

/**
 * Global ON is not enough: the org must be on the env allowlist.
 * Empty / missing / unreadable / non-UUID entries → OFF.
 * orgId empty or not a UUID → OFF.
 */
export function isCredentialAutoRenewOnForOrg(orgId: string | null | undefined): boolean {
  try {
    if (!isUuid(orgId)) return false;
    if (!isCredentialAutoRenewEnabled()) return false;
    const list = allowlistEntries();
    if (list === null) return false;
    if (list.length === 0) return !isCredentialAutoRenewOrgAllowlistRequired();
    const needle = orgId.toLowerCase();
    return list.some((id) => id.toLowerCase() === needle);
  } catch {
    return false;
  }
}

export const CREDENTIAL_AUTO_RENEW_ALLOWED_ARGS = ["employeeId", "reason", "jobId", "approvalId"] as const;
export const CREDENTIAL_AUTO_RENEW_REASONS = ["now"] as const;
export type CredentialAutoRenewReason = (typeof CREDENTIAL_AUTO_RENEW_REASONS)[number];

const FLAG_OFF = {
  code: "feature_disabled",
  message: "社員証の自動更新は無効です（CREDENTIAL_AUTO_RENEW_ENABLED / 許可リスト）。",
} as const;
const NOT_FOUND = { code: "employee_not_found", message: "AI社員が見つかりません" } as const;

export type CredentialAutoRenewToolOutcome =
  | { kind: "result"; data: Record<string, unknown>; isError?: boolean }
  | {
      kind: "queue";
      title: string;
      queuedArgs: Record<string, unknown>;
      summary: string;
      oldCredentialId: string;
    };

const fail = (code: string, message: string, extra: Record<string, unknown> = {}): CredentialAutoRenewToolOutcome => ({
  kind: "result",
  isError: true,
  data: { ok: false, code, error: code, message, ...extra },
});

export function parseAutoRenewReason(value: unknown): CredentialAutoRenewReason | null {
  if (value === undefined || value === null || value === "") return "now";
  return value === "now" ? "now" : null;
}

function holdCode(code: string): string {
  if (code === "employee_terminated") return "employee_terminated";
  if (code === "hold_state_unavailable") return "hold_state_unavailable";
  return "held";
}

async function closePendingRenewalsForClosedTickets(orgId: string): Promise<number> {
  const rows = await listPendingApprovalCredentialRenewals(orgId);
  let n = 0;
  for (const row of rows) {
    const approval = await getApprovalById(row.approvalId, orgId);
    if (!approval) continue;
    const next =
      approval.status === "rejected" ? "rejected" : approval.status === "expired" || approval.status === "superseded" ? "expired" : null;
    if (!next) continue;
    const closed = await markCredentialRenewalClosed({ orgId, approvalId: row.approvalId, state: next });
    if (closed) n += 1;
  }
  return n;
}

async function expireThenFindOpen(orgId: string, employeeId: string, now?: Date) {
  await expireStaleCredentialRenewals({ orgId, now }).catch(() => 0);
  return findOpenCredentialRenewalRow(orgId, employeeId);
}

export async function findOpenCredentialRenewal(orgId: string, employeeId: string) {
  return findOpenCredentialRenewalRow(orgId, employeeId);
}

export async function expireStaleCredentialRenewals(input: { orgId: string; now?: Date }): Promise<number> {
  if (!isCredentialAutoRenewOnForOrg(input.orgId)) return 0;
  const expired = await expireStaleCredentialRenewalRows(input);
  const closed = await closePendingRenewalsForClosedTickets(input.orgId).catch(() => 0);
  return expired + closed;
}

type GateOk = {
  ok: true;
  employee: NonNullable<Awaited<ReturnType<typeof getEmployee>>>;
  oldCredentialId: string;
};
type GateErr = { ok: false; code: string; message: string };

export async function gateEmployeeForRenew(input: {
  orgId: string;
  employeeId: string;
  phase: "wake" | "approval_execution" | "credential";
}): Promise<GateOk | GateErr> {
  if (!isCredentialAutoRenewOnForOrg(input.orgId)) return { ok: false, code: FLAG_OFF.code, message: FLAG_OFF.message };
  const employee = await getEmployee(input.employeeId, input.orgId);
  if (!employee || employee.orgId !== input.orgId) return { ok: false, code: NOT_FOUND.code, message: NOT_FOUND.message };
  if (employee.status !== "active") return { ok: false, code: "employee_terminated", message: "この AI 社員は停止されています。" };
  const operable = await checkOperable({ orgId: input.orgId, employeeId: employee.id, phase: input.phase });
  if (!operable.ok) {
    return {
      ok: false,
      code: holdCode(operable.code),
      message:
        operable.code === "employee_terminated"
          ? "この AI 社員は停止されています。"
          : operable.code === "hold_state_unavailable"
            ? "緊急停止の状態を確認できません。"
            : "この AI 社員は停止中のため更新できません。",
    };
  }
  const binding = await getBinding(employee.id);
  if (binding?.status === "revoked") return { ok: false, code: "revoked", message: "取り消された連携の社員証は更新できません。" };
  const oldCredentialId = (employee.credentialId || "").trim();
  if (!oldCredentialId) return { ok: false, code: "no_live_credential", message: "有効な社員証がありません。" };
  const expiry = credentialExpiry(employee);
  if (expiry.state === "expired") return { ok: false, code: "expired", message: "期限切れの社員証は自動更新の対象外です。ダッシュボードから再発行してください。" };
  return { ok: true, employee, oldCredentialId };
}

function summaryJa(employeeId: string, unlimited: boolean): string {
  const ttl = unlimited ? "無期限→90日" : "期限あり→今+90日";
  return `AI社員 ${employeeId} の社員証を今すぐ更新します（${ttl}）。承認しても鍵は AI に返しません。`;
}

export async function handleCredentialAutoRenewTool(
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<CredentialAutoRenewToolOutcome> {
  if (!isCredentialAutoRenewOnForOrg(cred.orgId)) return fail(FLAG_OFF.code, FLAG_OFF.message);
  const unsafe = rejectUnsafeArgs(args, CREDENTIAL_AUTO_RENEW_ALLOWED_ARGS);
  if (unsafe) return unsafe as CredentialAutoRenewToolOutcome;
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  if (!employeeId) return fail("missing_required_fields", "employeeId が必要です");
  const reason = parseAutoRenewReason(args.reason);
  if (!reason) return fail("invalid_reason", "reason は now のみです");
  const gated = await gateEmployeeForRenew({ orgId: cred.orgId, employeeId, phase: "wake" });
  if (!gated.ok) return fail(gated.code, gated.message);
  const binding = await getBinding(gated.employee.id);
  if (selfBound(cred.grokBotAgentId, binding?.grokBotAgentId)) {
    return fail("cannot_target_self", "管理エージェントは自分の社員証を更新できません。");
  }
  const open = await expireThenFindOpen(cred.orgId, gated.employee.id);
  if (open) return fail("already_pending", "進行中の社員証更新があります。");
  const unlimited = credentialExpiry(gated.employee).state === "no_expiry";
  return {
    kind: "queue",
    title: "社員証を更新しますか",
    queuedArgs: { employeeId: gated.employee.id, reason },
    summary: summaryJa(gated.employee.id, unlimited),
    oldCredentialId: gated.oldCredentialId,
  };
}

export async function recordCredentialAutoRenewFiling(input: {
  orgId: string;
  employeeId: string;
  oldCredentialId: string;
  approvalId: string;
  source: "web" | "admin_mcp";
}): Promise<{ ok: true; renewal: CredentialRenewalRow } | { ok: false; code: string; message: string }> {
  const row = await insertOrReuseCredentialRenewal({
    orgId: input.orgId,
    employeeId: input.employeeId,
    oldCredentialId: input.oldCredentialId,
    approvalId: input.approvalId,
    threshold: "now",
  });
  if (!row) return { ok: false, code: "already_pending", message: "進行中の社員証更新があります。" };
  await appendAdminClassAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId,
    credentialId: input.oldCredentialId,
    legacyAction: "credential.renew_proposed",
    adminAction: "admin.credential.renew_proposed",
    purpose: "admin.policy",
    summary: "社員証の今すぐ更新を起票",
    target: { type: "employee", id: input.employeeId },
    reason: adminAuditReason("needs_approval"),
    result: "pending",
    metadata: {
      approvalId: input.approvalId,
      employeeId: input.employeeId,
      oldCredentialId: input.oldCredentialId,
      threshold: "now",
      source: input.source,
    },
  }).catch(() => undefined);
  return { ok: true, renewal: row };
}

export type ProposeCredentialAutoRenewResult =
  | { ok: true; approvalId: string; nextStepJa: string }
  | { ok: false; code: string; messageJa: string };

export async function proposeCredentialAutoRenewNow(input: {
  orgId: string;
  employeeId: string;
  source: "web" | "admin_mcp";
  actor: { memberId: string; email: string | null };
}): Promise<ProposeCredentialAutoRenewResult> {
  const gated = await gateEmployeeForRenew({ orgId: input.orgId, employeeId: input.employeeId, phase: "wake" });
  if (!gated.ok) return { ok: false, code: gated.code, messageJa: gated.message };
  const open = await expireThenFindOpen(input.orgId, gated.employee.id);
  if (open) return { ok: false, code: "already_pending", messageJa: "進行中の社員証更新があります。" };
  const authorityStop = await approverFilingStop({
    orgId: input.orgId,
    tool: CREDENTIAL_AUTO_RENEW_ADMIN_TOOL,
    metadata: {
      adminMutation: { employeeId: gated.employee.id, reason: "now" },
      adminRequester: { kind: "human", actorId: input.actor.memberId },
    },
  });
  if (authorityStop) return { ok: false, code: authorityStop.reason, messageJa: authorityStop.messageJa };
  const unlimited = credentialExpiry(gated.employee).state === "no_expiry";
  const created = await createApproval({
    orgId: input.orgId,
    employeeId: gated.employee.id,
    credentialId: gated.oldCredentialId,
    title: "社員証を更新しますか",
    purpose: "admin.policy",
    summary: summaryJa(gated.employee.id, unlimited),
    risk: "high",
    tool: CREDENTIAL_AUTO_RENEW_ADMIN_TOOL,
    jobId: `admin_${CREDENTIAL_AUTO_RENEW_ADMIN_TOOL}_${Date.now().toString(36)}`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalClass: ADMIN_AUDIT_CLASS,
      auditAction: "admin.policy",
      always_human: true,
      adminTool: CREDENTIAL_AUTO_RENEW_ADMIN_TOOL,
      isAdminMcpTool: input.source === "admin_mcp",
      adminMutation: { employeeId: gated.employee.id, reason: "now" },
      adminRequester: { kind: "human", actorId: input.actor.memberId },
    },
  });
  const recorded = await recordCredentialAutoRenewFiling({
    orgId: input.orgId,
    employeeId: gated.employee.id,
    oldCredentialId: gated.oldCredentialId,
    approvalId: created.approval.id,
    source: input.source,
  });
  if (!recorded.ok) return { ok: false, code: recorded.code, messageJa: recorded.message };
  void sendApprovalNotifications(created.approval, null).catch(() => null);
  return {
    ok: true,
    approvalId: created.approval.id,
    nextStepJa: "承認者の Slack に「更新しますか」を送りました。鍵はこの画面には出ません。",
  };
}

export type CredentialAutoRenewFulfillment =
  | { ok: true; employeeId: string; summaryJa: string; nextStepJa: string }
  | { ok: false; code: string; messageJa: string; employeeId?: string };

export async function fulfillCredentialAutoRenew(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<CredentialAutoRenewFulfillment> {
  const orgId = approval.orgId;
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  const audit = async (action: "credential.renew_approved" | "credential.renew_rejected" | "credential.renew_skipped_hold", extra: Record<string, unknown>) =>
    appendAdminClassAuditEvent({
      orgId,
      employeeId: employeeId || null,
      credentialId: null,
      actorEmail: approval.resolvedBy ?? undefined,
      approval,
      legacyAction: action,
      adminAction: `admin.${action}` as
        | "admin.credential.renew_approved"
        | "admin.credential.renew_rejected"
        | "admin.credential.renew_skipped_hold",
      purpose: "admin.policy",
      summary:
        action === "credential.renew_approved"
          ? "社員証の今すぐ更新を承認（まだ発行していません）"
          : `社員証の今すぐ更新を中止（${String(extra.code)}）`,
      target: employeeId ? { type: "employee", id: employeeId } : { type: "approval", id: approval.id },
      reason: adminAuditReason(
        action === "credential.renew_approved"
          ? "approved"
          : action === "credential.renew_skipped_hold"
            ? "approval_held"
            : typeof extra.code === "string"
              ? extra.code
              : "rejected"
      ),
      result: action === "credential.renew_approved" ? "success" : "denied",
      metadata: {
        approvalId: approval.id,
        employeeId: employeeId || null,
        threshold: "now",
        tool: CREDENTIAL_AUTO_RENEW_ADMIN_TOOL,
        actor: requesterOf(approval),
        approver: isAdminAuditSixFieldWriteEnabledForOrg(orgId)
          ? maskEmail(approval.resolvedBy)
          : approval.resolvedBy ?? null,
        ...extra,
      },
    }).catch(() => undefined);
  const stop = async (code: string, messageJa: string): Promise<CredentialAutoRenewFulfillment> => {
    await audit(code === "held" || code === "hold_state_unavailable" ? "credential.renew_skipped_hold" : "credential.renew_rejected", { code });
    return { ok: false, code, messageJa, ...(employeeId ? { employeeId } : {}) };
  };
  if (!isCredentialAutoRenewOnForOrg(orgId)) return stop(FLAG_OFF.code, FLAG_OFF.message);
  if (!employeeId) return stop("invalid_payload", "employeeId がありません");
  const gated = await gateEmployeeForRenew({ orgId, employeeId, phase: "approval_execution" });
  if (!gated.ok) return stop(gated.code, gated.message);
  const until = new Date(Date.now() + CREDENTIAL_AUTO_RENEW_CLAIM_WINDOW_MS).toISOString();
  const marked = await markCredentialRenewalClaimable({
    orgId,
    employeeId: gated.employee.id,
    approvalId: approval.id,
    claimableUntil: until,
  });
  if (!marked) return stop("already_pending", "受け取り窓を開けませんでした。");
  await audit("credential.renew_approved", { claimableUntil: until, oldCredentialId: gated.oldCredentialId });
  return {
    ok: true,
    employeeId,
    summaryJa: `AI社員 ${employeeId} の社員証更新が承認されました（まだ発行していません）。`,
    nextStepJa:
      "承認済みです。起動スクリプトが受け取るまで古い社員証はそのまま使えます。鍵はこの画面と AI には出しません。チャットに鍵を貼らないでください。",
  };
}

