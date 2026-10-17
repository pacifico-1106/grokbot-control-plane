/**
 * Employee retirement (EMPLOYEE_RETIRE_ENABLED for admin MCP filing, default OFF).
 *
 * Status value is the existing check-constraint `suspended` (契約終了).
 * Dashboard humans execute via retireEmployee / the existing terminate route.
 * Admin MCP employees.retire only files an always_human ticket; fulfil does
 * not retire — it returns a dashboard pointer. AI (employee MCP) cannot call it.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { requesterOf } from "@/lib/admin-mcp/allowed-accounts-tools";
import { rejectUnsafeArgs } from "@/lib/admin-mcp/slack-dm-setup";
import { appendAuditEvent } from "@/lib/data/audit";
import { getEmployee, terminateEmployee } from "@/lib/data/employees";
import { isEmployeeRetireEnabled } from "@/lib/feature-flags";
import { revokeAllEmployeeGrants } from "@/lib/mcp-oauth/grant-admin";
import { dropPendingDeliveries, markRevokedForEmployee } from "@/lib/mcp-events/store";
import { disableCommAccount, listCommAccounts } from "@/lib/comm/accounts";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { getRuntimeEmployees } from "@/lib/demo-data";
import type { ApprovalRequest, Employee } from "@/lib/types";

export const EMPLOYEE_RETIRE_TOOL = "employees.retire" as const;
export const EMPLOYEE_RETIRE_ALLOWED_ARGS = ["employeeId", "jobId", "approvalId"] as const;

const FLAG_OFF = {
  code: "feature_disabled",
  message: "退職ツールは無効です（EMPLOYEE_RETIRE_ENABLED）。ダッシュボードの AI社員ページから契約終了してください。",
} as const;
const NOT_FOUND = { code: "employee_not_found", message: "AI社員が見つかりません" } as const;

export type RetireResult = {
  employee: Employee;
  alreadyRetired: boolean;
  oauthGrantsRevoked: number;
};

export async function stopEmployeeWakeAndNotices(input: {
  orgId: string;
  employeeId: string;
}): Promise<void> {
  const orgId = input.orgId.trim();
  const employeeId = input.employeeId.trim();
  if (!orgId || !employeeId) return;
  const nowIso = new Date().toISOString();
  try {
    const ids = await markRevokedForEmployee(orgId, employeeId, "employee_retired", nowIso);
    if (ids.length) await dropPendingDeliveries(ids, "employee_retired", nowIso);
  } catch {
    // tables may be absent while MCP_EVENTS is OFF
  }
  try {
    const accounts = await listCommAccounts(orgId);
    for (const account of accounts) {
      if (account.orgId === orgId && account.employeeId === employeeId && account.status !== "disabled") {
        await disableCommAccount(orgId, account.id);
      }
    }
  } catch {
    // comm accounts flag OFF or unreadable
  }
  if (isDemoMode()) {
    const emp = getRuntimeEmployees().find((item) => item.id === employeeId && item.orgId === orgId);
    if (emp) Object.assign(emp, { callbackUrl: null });
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin
    .from("employees")
    .update({ callback_url: null, updated_at: nowIso })
    .eq("id", employeeId)
    .eq("org_id", orgId);
}

export async function retireEmployee(input: {
  orgId: string;
  employeeId: string;
  actorEmail: string;
  reason?: string;
}): Promise<RetireResult | null> {
  const orgId = input.orgId?.trim();
  const employeeId = input.employeeId?.trim();
  const actorEmail = input.actorEmail?.trim();
  if (!orgId || !employeeId || !actorEmail) return null;
  const before = await getEmployee(employeeId, orgId);
  if (!before || before.orgId !== orgId) return null;
  const alreadyRetired = before.status === "suspended";
  const employee = await terminateEmployee({ orgId, employeeId });
  if (!employee || employee.orgId !== orgId) return null;

  let oauthGrantsRevoked = 0;
  try {
    oauthGrantsRevoked = await revokeAllEmployeeGrants({
      orgId,
      employeeId,
      byEmail: actorEmail,
      reason: "terminate",
    });
  } catch {
    oauthGrantsRevoked = 0;
  }
  await stopEmployeeWakeAndNotices({ orgId, employeeId });

  await appendAuditEvent({
    orgId,
    employeeId,
    credentialId: employee.credentialId,
    actorEmail,
    action: "credential.revoked",
    purpose: null,
    summary: `${employee.displayName} の社員証を失効`,
    metadata: { reason: "retire", actor: "human", alreadyRetired },
  });
  await appendAuditEvent({
    orgId,
    employeeId,
    credentialId: employee.credentialId,
    actorEmail,
    action: "employee.terminated",
    purpose: null,
    summary: `${employee.displayName} の契約を終了（社員証失効・停止。番号と監査は残す）`,
    metadata: {
      status: employee.status,
      actor: "human",
      reason: input.reason?.trim() || "retire",
      alreadyRetired,
    },
  });

  return { employee, alreadyRetired, oauthGrantsRevoked };
}

export type EmployeeRetireToolOutcome =
  | { kind: "result"; data: Record<string, unknown>; isError?: boolean }
  | { kind: "queue"; title: string; queuedArgs: Record<string, unknown>; summary: string };

const fail = (code: string, message: string, extra: Record<string, unknown> = {}): EmployeeRetireToolOutcome => ({
  kind: "result",
  isError: true,
  data: { ok: false, code, error: code, message, ...extra },
});

function dashboardPath(employeeId: string): string {
  return `/app/employees/${encodeURIComponent(employeeId)}`;
}

function handoverJa(employeeId: string): string {
  return (
    `退職の実行は管理画面の人間だけが行います。credential 管理権限のある人が ${dashboardPath(employeeId)} を開き、` +
    `確認語「契約終了」を入力して実行してください。AI はこの操作を実行できません。`
  );
}

export async function handleEmployeeRetireTool(
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<EmployeeRetireToolOutcome> {
  if (!isEmployeeRetireEnabled()) return fail(FLAG_OFF.code, FLAG_OFF.message);
  const unsafe = rejectUnsafeArgs(args, EMPLOYEE_RETIRE_ALLOWED_ARGS);
  if (unsafe) return unsafe as EmployeeRetireToolOutcome;
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  if (!employeeId) return fail("missing_required_fields", "employeeId が必要です");
  const employee = await getEmployee(employeeId, cred.orgId);
  if (!employee || employee.orgId !== cred.orgId) return fail(NOT_FOUND.code, NOT_FOUND.message);
  return {
    kind: "queue",
    title: "AI社員の退職（契約終了）",
    queuedArgs: { employeeId: employee.id },
    summary:
      `AI社員 ${employee.id}（${employee.displayName}）を退職にします（status=suspended、社員証・OAuth・wake/通知を停止）。` +
      `承認してもここでは実行しません。ダッシュボードで人が契約終了します。`,
  };
}

export type EmployeeRetireFulfillment =
  | { ok: true; employeeId: string; summaryJa: string; nextStepJa: string }
  | { ok: false; code: string; messageJa: string; employeeId?: string };

export async function fulfillEmployeeRetire(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<EmployeeRetireFulfillment> {
  const orgId = approval.orgId;
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  const audit = async (event: string, extra: Record<string, unknown>) =>
    appendAuditEvent({
      orgId,
      employeeId: employeeId || null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary:
        event === "employee.retire_approved"
          ? "AI社員の退職を承認（実行はダッシュボード）"
          : `AI社員の退職を中止（${String(extra.code)}）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        event,
        tool: EMPLOYEE_RETIRE_TOOL,
        approvalId: approval.id,
        employeeId: employeeId || null,
        actor: requesterOf(approval),
        approver: approval.resolvedBy ?? null,
        ...extra,
      },
    }).catch(() => undefined);
  const stop = async (code: string, messageJa: string): Promise<EmployeeRetireFulfillment> => {
    await audit("employee.retire_rejected", { code });
    return { ok: false, code, messageJa, ...(employeeId ? { employeeId } : {}) };
  };
  if (!isEmployeeRetireEnabled()) return stop(FLAG_OFF.code, FLAG_OFF.message);
  if (!employeeId) return stop("invalid_payload", "employeeId がありません");
  const employee = await getEmployee(employeeId, orgId);
  if (!employee || employee.orgId !== orgId) return stop(NOT_FOUND.code, NOT_FOUND.message);
  await audit("employee.retire_approved", {});
  return {
    ok: true,
    employeeId,
    summaryJa: `AI社員 ${employeeId} の退職が承認されました（まだ実行していません）。`,
    nextStepJa: handoverJa(employeeId),
  };
}
