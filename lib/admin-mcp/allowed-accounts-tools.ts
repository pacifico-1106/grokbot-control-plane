/**
 * Admin MCP tools to edit an existing AI employee badge's allowedAccounts.
 *
 *   employees.allowedAccounts.add     always_human (ticket → change on fulfillment)
 *   employees.allowedAccounts.remove  always_human (ticket → change on fulfillment)
 *   employees.allowedAccounts.list    read-only
 *
 * All three require ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED (default OFF).
 *
 * Security invariants (tests in allowed-accounts-tools.test.ts):
 * - orgId ALWAYS comes from the admin credential (queue) / the approval row
 *   (fulfillment). No orgId argument; unknown arguments are rejected.
 * - Another org's employee gets the same `employee_not_found` as a missing id.
 * - The admin agent cannot edit the badge bound to its own Grok Bot.
 * - Strict per-provider format; unknown / free-text providers are rejected
 *   (free-text services stay dashboard-only).
 * - Same storage and normalization as the dashboard「ブラウザ・外部アカウント」
 *   (normalizeAllowedAccounts → employees.allowed_accounts + active credential),
 *   including the browser:use rule (never leave the list empty).
 * - Fulfillment re-validates everything against the CURRENT state and writes
 *   an admin-class audit row (actor, approver, employee, provider, before/after,
 *   ticket id).
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { rejectUnsafeArgs } from "@/lib/admin-mcp/slack-dm-setup";
import { appendAuditEvent } from "@/lib/data/audit";
import { getBinding } from "@/lib/data/bindings";
import { getEmployee, updateEmployeeAllowedAccounts } from "@/lib/data/employees";
import { getEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { normalizeAllowedAccounts, serviceLabel } from "@/lib/employees/allowed-accounts";
import type { AllowedAccount, ApprovalRequest, Employee } from "@/lib/types";

export const ALLOWED_ACCOUNTS_ADD_TOOL = "employees.allowedAccounts.add";
export const ALLOWED_ACCOUNTS_REMOVE_TOOL = "employees.allowedAccounts.remove";
export const ALLOWED_ACCOUNTS_LIST_TOOL = "employees.allowedAccounts.list";
export const ALLOWED_ACCOUNTS_TOOLS = [
  ALLOWED_ACCOUNTS_ADD_TOOL,
  ALLOWED_ACCOUNTS_REMOVE_TOOL,
  ALLOWED_ACCOUNTS_LIST_TOOL,
] as const;
export type AllowedAccountsTool = (typeof ALLOWED_ACCOUNTS_TOOLS)[number];

export function isAllowedAccountsTool(name: string): name is AllowedAccountsTool {
  return (ALLOWED_ACCOUNTS_TOOLS as readonly string[]).includes(name);
}

export const ALLOWED_ACCOUNTS_TOOLS_FLAG = "ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/** ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED (default OFF). */
export function isAdminMcpAllowedAccountsToolsEnabled(): boolean {
  return parseFlag(process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG]);
}

/**
 * For guidance text in other flows (e.g. #240 Slack re-authorize link): true
 * only when `employees.allowedAccounts.add` will actually work right now.
 * The tools are always in the registry (tools/list === callable); the flag
 * decides whether they do anything.
 */
export function isEmployeesAllowedAccountsAdminToolAvailable(): boolean {
  return isAdminMcpAllowedAccountsToolsEnabled();
}

export const ALLOWED_ACCOUNTS_DASHBOARD_NEXT_STEP_JA =
  "ダッシュボードの AI 社員ページ「ブラウザ・外部アカウント」で、人が追加・削除して保存してください。";

// ---------------------------------------------------------------------------
// Validation (per provider)
// ---------------------------------------------------------------------------

/** Slack user id (U… / W… Enterprise Grid). Uppercase only, no <@…> wrapping. */
export const SLACK_ALLOWED_ACCOUNT_USER_ID_RE = /^[UW][A-Z0-9]{8,20}$/;
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** SNS handle / page id: optional @, no spaces / URLs / separators. */
const HANDLE_RE = /^@?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_LABEL = 80;

type ProviderKind = "slack_user" | "email" | "handle";

/**
 * Providers accepted by the admin tools: the dashboard preset keys
 * (ACCOUNT_SERVICE_PRESETS) except "other". Free-text services remain
 * dashboard-only (a human types them).
 */
const PROVIDER_KIND: Record<string, ProviderKind> = {
  slack: "slack_user",
  google: "email",
  microsoft365: "email",
  line: "handle",
  x: "handle",
  note: "handle",
  linkedin: "handle",
  youtube: "handle",
  instagram: "handle",
  facebook: "handle",
};
export const ALLOWED_ACCOUNTS_PROVIDERS = Object.keys(PROVIDER_KIND);

const FORMAT_HINT_JA: Record<ProviderKind, string> = {
  slack_user: "Slack の user ID（U または W で始まる英大文字・数字 9 文字以上、例: U0123ABCD9）",
  email: "メールアドレス（例: sales@example.co.jp）",
  handle: "ID / ハンドル（英数字と . _ -、先頭 @ 可。URL や空白は不可）",
};

export type AllowedAccountValidation =
  | { ok: true; provider: string; accountId: string; kind: ProviderKind }
  | { ok: false; code: "unsupported_provider" | "invalid_account_id"; message: string };

export function validateAllowedAccountInput(input: { provider: unknown; accountId: unknown }): AllowedAccountValidation {
  const provider = typeof input.provider === "string" ? input.provider : "";
  const kind = Object.prototype.hasOwnProperty.call(PROVIDER_KIND, provider) ? PROVIDER_KIND[provider] : undefined;
  if (!kind) {
    return {
      ok: false,
      code: "unsupported_provider",
      message: `provider は ${ALLOWED_ACCOUNTS_PROVIDERS.join(", ")} のいずれかです（自由記入のサービスはダッシュボードで人が登録します）。`,
    };
  }
  const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
  const re = kind === "slack_user" ? SLACK_ALLOWED_ACCOUNT_USER_ID_RE : kind === "email" ? EMAIL_RE : HANDLE_RE;
  if (!accountId || accountId.length > 254 || !re.test(accountId)) {
    return { ok: false, code: "invalid_account_id", message: `accountId は ${FORMAT_HINT_JA[kind]} で指定してください。` };
  }
  return { ok: true, provider, accountId, kind };
}

function sameAccount(row: AllowedAccount, provider: string, accountId: string, kind: ProviderKind): boolean {
  if (row.service.trim().toLowerCase() !== provider) return false;
  const stored = row.accountId.trim();
  // Slack ids are matched exactly (employeeAllowsSlackUser is exact).
  if (kind === "slack_user") return stored === accountId;
  if (kind === "handle") return stored.replace(/^@/, "").toLowerCase() === accountId.replace(/^@/, "").toLowerCase();
  return stored.toLowerCase() === accountId.toLowerCase();
}

type ParsedLabel = { ok: true; label?: string } | { ok: false };

function parseLabel(value: unknown): ParsedLabel {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const label = value.trim();
  if (label.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(label)) return { ok: false };
  return { ok: true, label: label || undefined };
}

function displayNameJa(employee: Employee): string {
  const name = (employee.displayName || "").replace(/\s+/g, " ").trim() || employee.id;
  return name.length > 40 ? `${name.slice(0, 40)}…` : name;
}

function changeJa(kind: "add" | "remove", employee: Employee, provider: string, accountId: string): string {
  return kind === "add"
    ? `社員「${displayNameJa(employee)}」の許可アカウントに ${serviceLabel(provider)} ${accountId} を追加`
    : `社員「${displayNameJa(employee)}」の許可アカウントから ${serviceLabel(provider)} ${accountId} を削除`;
}

function selfBound(adminGrokBotAgentId: string | null | undefined, bound: string | null | undefined): boolean {
  const mine = (adminGrokBotAgentId || "").trim();
  const theirs = (bound || "").trim();
  return Boolean(mine && theirs && mine === theirs);
}

function browserUseNeedsAccounts(employee: Employee, after: AllowedAccount[]): boolean {
  return (employee.scopes as string[]).includes("browser:use") && after.length === 0;
}

// ---------------------------------------------------------------------------
// Tool handler (queue phase) — called from callAdminMcpTool
// ---------------------------------------------------------------------------
// Existing Slack identity notice (remove)
// ---------------------------------------------------------------------------

/**
 * Runtime Slack paths do not re-check allowedAccounts: inbound wake
 * (getEmployeesBySlackUserIds / IM routes) and user-token sending
 * (getLinkedSlackUserToken) only read employee_slack_identities.
 * allowedAccounts is enforced when an identity is bound
 * (bindEmployeeSlackIdentity: OAuth callback and the #240 re-authorize link).
 * So removing a Slack U… leaves an already linked identity working; we say so
 * instead of silently implying it stopped. No auto-unlink here.
 */
export const SLACK_IDENTITY_REMAINS_NOTICE_JA =
  "既存の Slack 紐づけは残っています。止めるにはダッシュボードで解除してください";
export const SLACK_IDENTITY_UNLINK_NEXT_STEP_JA =
  "ダッシュボードの AI社員詳細 →「Slack 連携（Authorize）」→「連携を解除」で止められます。";

/** True only when this employee has a LINKED identity for exactly this Slack user, in this org. */
async function slackIdentityRemainsFor(employee: Employee, provider: string, accountId: string): Promise<boolean> {
  if (provider !== "slack") return false;
  const identity = await getEmployeeSlackIdentity(employee.id).catch(() => null);
  return Boolean(
    identity &&
      identity.orgId === employee.orgId &&
      identity.status === "linked" &&
      identity.slackUserId.trim().toUpperCase() === accountId.trim().toUpperCase()
  );
}

function slackNoticeFields(remains: boolean): Record<string, unknown> {
  return remains
    ? { slackIdentityRemains: true, slackIdentityNoticeJa: SLACK_IDENTITY_REMAINS_NOTICE_JA, nextStepJa: SLACK_IDENTITY_UNLINK_NEXT_STEP_JA }
    : {};
}

// ---------------------------------------------------------------------------

export type AllowedAccountsToolOutcome =
  | { kind: "result"; data: Record<string, unknown>; isError?: boolean }
  | {
      kind: "queue";
      queuedArgs: Record<string, unknown>;
      summary: string;
      title: string;
      /** Extra fields merged into the MCP result once the ticket is queued. */
      resultExtra?: Record<string, unknown>;
    };

function fail(code: string, message: string, extra: Record<string, unknown> = {}): AllowedAccountsToolOutcome {
  return { kind: "result", data: { ok: false, code, message, ...extra }, isError: true };
}

const ALLOWED_ARGS: Record<AllowedAccountsTool, readonly string[]> = {
  [ALLOWED_ACCOUNTS_ADD_TOOL]: ["employeeId", "provider", "accountId", "label", "jobId", "approvalId"],
  [ALLOWED_ACCOUNTS_REMOVE_TOOL]: ["employeeId", "provider", "accountId", "jobId", "approvalId"],
  [ALLOWED_ACCOUNTS_LIST_TOOL]: ["employeeId"],
};

const NOT_FOUND = { code: "employee_not_found", message: "AI社員が見つかりません" } as const;

export async function handleAllowedAccountsTool(
  name: AllowedAccountsTool,
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<AllowedAccountsToolOutcome> {
  if (!isAdminMcpAllowedAccountsToolsEnabled()) {
    return fail(
      "allowed_accounts_tools_disabled",
      `${ALLOWED_ACCOUNTS_TOOLS_FLAG} が OFF です（運営が ON にしてから使えます）。`,
      { nextStepJa: ALLOWED_ACCOUNTS_DASHBOARD_NEXT_STEP_JA }
    );
  }
  const unsafe = rejectUnsafeArgs(args, ALLOWED_ARGS[name]);
  if (unsafe) return unsafe as AllowedAccountsToolOutcome;

  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  if (!employeeId) return fail("missing_required_fields", "employeeId が必要です");

  if (name === ALLOWED_ACCOUNTS_LIST_TOOL) {
    const employee = await getEmployee(employeeId, cred.orgId);
    if (!employee || employee.orgId !== cred.orgId) return fail(NOT_FOUND.code, NOT_FOUND.message);
    return {
      kind: "result",
      data: {
        ok: true,
        employeeId: employee.id,
        displayName: employee.displayName,
        allowedAccounts: normalizeAllowedAccounts(employee.allowedAccounts),
        providers: ALLOWED_ACCOUNTS_PROVIDERS,
      },
    };
  }

  if (typeof args.provider !== "string" || typeof args.accountId !== "string" || !args.provider || !args.accountId.trim()) {
    return fail("missing_required_fields", "employeeId, provider, accountId が必要です");
  }
  const parsed = validateAllowedAccountInput({ provider: args.provider, accountId: args.accountId });
  if (!parsed.ok) return fail(parsed.code, parsed.message);
  const label = name === ALLOWED_ACCOUNTS_ADD_TOOL ? parseLabel(args.label) : ({ ok: true } as ParsedLabel);
  if (!label.ok) return fail("invalid_label", `label は ${MAX_LABEL} 文字以内の文字列で指定してください。`);

  const employee = await getEmployee(employeeId, cred.orgId);
  if (!employee || employee.orgId !== cred.orgId) return fail(NOT_FOUND.code, NOT_FOUND.message);
  if (employee.status === "suspended") return fail("employee_terminated", "この AI 社員は停止されています。");
  const binding = await getBinding(employee.id);
  if (selfBound(cred.grokBotAgentId, binding?.grokBotAgentId)) {
    return fail("cannot_target_self", "管理エージェントは自分の社員証の許可アカウントを変更できません。");
  }

  const current = normalizeAllowedAccounts(employee.allowedAccounts);
  const present = current.some((row) => sameAccount(row, parsed.provider, parsed.accountId, parsed.kind));

  if (name === ALLOWED_ACCOUNTS_ADD_TOOL) {
    if (present) {
      return {
        kind: "result",
        data: {
          ok: true,
          code: "already_allowed",
          alreadyPresent: true,
          changed: false,
          employeeId: employee.id,
          provider: parsed.provider,
          accountId: parsed.accountId,
          message: `社員「${displayNameJa(employee)}」の許可アカウントには ${serviceLabel(parsed.provider)} ${parsed.accountId} が既にあります（変更なし・承認不要）。`,
        },
      };
    }
    return {
      kind: "queue",
      title: "AI社員の許可アカウント追加",
      queuedArgs: {
        employeeId: employee.id,
        provider: parsed.provider,
        accountId: parsed.accountId,
        ...(label.label ? { label: label.label } : {}),
      },
      summary: `${changeJa("add", employee, parsed.provider, parsed.accountId)}します（現在 ${current.length} 件 → ${current.length + 1} 件）。承認すると反映されます。`,
    };
  }

  const slackRemains = await slackIdentityRemainsFor(employee, parsed.provider, parsed.accountId);
  if (!present) {
    return fail(
      "allowed_account_not_found",
      `社員「${displayNameJa(employee)}」の許可アカウントに ${serviceLabel(parsed.provider)} ${parsed.accountId} はありません。employees.allowedAccounts.list で確認してください。${slackRemains ? SLACK_IDENTITY_REMAINS_NOTICE_JA + "。" : ""}`,
      slackNoticeFields(slackRemains)
    );
  }
  const after = current.filter((row) => !sameAccount(row, parsed.provider, parsed.accountId, parsed.kind));
  if (browserUseNeedsAccounts(employee, after)) {
    return fail(
      "allowed_accounts_required",
      "ブラウザ利用（browser:use）がある社員証は許可アカウントを 0 件にできません。先に別のアカウントを追加するか、ダッシュボードで権限を見直してください。"
    );
  }
  return {
    kind: "queue",
    title: "AI社員の許可アカウント削除",
    queuedArgs: { employeeId: employee.id, provider: parsed.provider, accountId: parsed.accountId },
    summary: `${changeJa("remove", employee, parsed.provider, parsed.accountId)}します（現在 ${current.length} 件 → ${after.length} 件）。承認すると反映されます。${slackRemains ? SLACK_IDENTITY_REMAINS_NOTICE_JA + "。" : ""}`,
    ...(slackRemains ? { resultExtra: slackNoticeFields(true) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fulfillment (human approved) — called from fulfillApprovedAdmin
// ---------------------------------------------------------------------------

export type AllowedAccountsFulfillment =
  | { ok: true; employeeId: string; changed: boolean; summaryJa: string; noticeJa?: string; nextStepJa?: string }
  | { ok: false; code: string; messageJa: string; noticeJa?: string; nextStepJa?: string };

function requesterOf(approval: ApprovalRequest): { kind: "admin_agent"; adminAgentId: string | null; grokBotAgentId: string | null } {
  const raw = approval.metadata?.adminRequester;
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    kind: "admin_agent",
    adminAgentId: typeof r.actorId === "string" ? r.actorId : null,
    grokBotAgentId: typeof r.grokBotAgentId === "string" ? r.grokBotAgentId : null,
  };
}

export async function fulfillAllowedAccountsChange(
  approval: ApprovalRequest,
  tool: typeof ALLOWED_ACCOUNTS_ADD_TOOL | typeof ALLOWED_ACCOUNTS_REMOVE_TOOL,
  args: Record<string, unknown>
): Promise<AllowedAccountsFulfillment> {
  const orgId = approval.orgId;
  const actor = requesterOf(approval);
  const approver = approval.resolvedBy ?? null;
  const failWith = async (code: string, messageJa: string, employeeId: string | null): Promise<AllowedAccountsFulfillment> => {
    await appendAuditEvent({
      orgId,
      employeeId,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `許可アカウントの変更を中止（${code}）`,
      metadata: { auditClass: ADMIN_AUDIT_CLASS, event: "employee.allowed_accounts.rejected", tool, approvalId: approval.id, code, actor, approver },
    }).catch(() => undefined);
    return { ok: false, code, messageJa };
  };

  if (!isAdminMcpAllowedAccountsToolsEnabled()) {
    return failWith("allowed_accounts_tools_disabled", `${ALLOWED_ACCOUNTS_TOOLS_FLAG} が OFF のため反映しませんでした。`, null);
  }
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  const parsed = validateAllowedAccountInput({ provider: args.provider, accountId: args.accountId });
  if (!parsed.ok) return failWith(parsed.code, parsed.message, null);
  const label = tool === ALLOWED_ACCOUNTS_ADD_TOOL ? parseLabel(args.label) : ({ ok: true } as ParsedLabel);
  if (!label.ok) return failWith("invalid_label", "label が不正です。", null);

  // Re-validate against the CURRENT state, in the approval's org only.
  const employee = employeeId ? await getEmployee(employeeId, orgId) : null;
  if (!employee || employee.orgId !== orgId) return failWith(NOT_FOUND.code, NOT_FOUND.message, null);
  if (employee.status === "suspended") return failWith("employee_terminated", "この AI 社員は停止されています。", employee.id);
  const binding = await getBinding(employee.id);
  if (selfBound(actor.grokBotAgentId, binding?.grokBotAgentId)) {
    return failWith("cannot_target_self", "依頼した管理エージェント自身の社員証は変更できません。", employee.id);
  }

  const before = normalizeAllowedAccounts(employee.allowedAccounts);
  const present = before.some((row) => sameAccount(row, parsed.provider, parsed.accountId, parsed.kind));
  const change = changeJa(tool === ALLOWED_ACCOUNTS_ADD_TOOL ? "add" : "remove", employee, parsed.provider, parsed.accountId);
  const auditBase = {
    auditClass: ADMIN_AUDIT_CLASS,
    tool,
    approvalId: approval.id,
    employeeId: employee.id,
    provider: parsed.provider,
    accountId: parsed.accountId,
    actor,
    approver,
  };

  if (tool === ALLOWED_ACCOUNTS_ADD_TOOL && present) {
    // Added meanwhile (e.g. on the dashboard): idempotent, never a duplicate.
    await appendAuditEvent({
      orgId,
      employeeId: employee.id,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `${change}（既に登録済みのため変更なし・管理MCP・人承認）`,
      metadata: { ...auditBase, event: "employee.allowed_accounts.unchanged", before, after: before },
    });
    return { ok: true, employeeId: employee.id, changed: false, summaryJa: `${change}する依頼でしたが、既に登録済みのため変更しませんでした。` };
  }
  // Remove: is a linked Slack identity for this U… still there (checked now, not at queue time)?
  const slackRemains =
    tool === ALLOWED_ACCOUNTS_REMOVE_TOOL && (await slackIdentityRemainsFor(employee, parsed.provider, parsed.accountId));
  const noticeSuffix = slackRemains ? `${SLACK_IDENTITY_REMAINS_NOTICE_JA}。` : "";
  const noticeOut = slackRemains
    ? { noticeJa: SLACK_IDENTITY_REMAINS_NOTICE_JA, nextStepJa: SLACK_IDENTITY_UNLINK_NEXT_STEP_JA }
    : {};
  if (tool === ALLOWED_ACCOUNTS_REMOVE_TOOL && !present) {
    const failed = await failWith(
      "allowed_account_not_found",
      `承認待ちの間に ${serviceLabel(parsed.provider)} ${parsed.accountId} が許可アカウントから外れていたため、反映しませんでした。${noticeSuffix}`,
      employee.id
    );
    return { ...failed, ...noticeOut };
  }

  const after =
    tool === ALLOWED_ACCOUNTS_ADD_TOOL
      ? normalizeAllowedAccounts([
          ...before,
          {
            service: parsed.provider,
            accountId: parsed.accountId,
            ...(label.label ? { label: label.label } : {}),
            browserRequired: parsed.provider === "google" || parsed.provider === "microsoft365",
          },
        ])
      : before.filter((row) => !sameAccount(row, parsed.provider, parsed.accountId, parsed.kind));
  if (browserUseNeedsAccounts(employee, after)) {
    return failWith("allowed_accounts_required", "browser:use がある社員証の許可アカウントは 0 件にできません。", employee.id);
  }

  let updated: Awaited<ReturnType<typeof updateEmployeeAllowedAccounts>>;
  try {
    updated = await updateEmployeeAllowedAccounts({ orgId, employeeId: employee.id, allowedAccounts: after });
  } catch (error) {
    // Fail-closed: a failed write is never reported as applied.
    const rolledBack = (error as { rolledBack?: unknown })?.rolledBack;
    console.error("allowed_accounts_update_failed", employee.id, error instanceof Error ? error.message : error);
    return failWith(
      "allowed_accounts_update_failed",
      rolledBack === false
        ? `${change}できませんでした（保存に失敗し、元に戻すこともできませんでした）。ダッシュボードの「ブラウザ・外部アカウント」で現在の状態を確認してください。`
        : `${change}できませんでした（保存に失敗したため、変更していません）。時間をおいて、もう一度依頼してください。`,
      employee.id
    );
  }
  if (!updated) return failWith(NOT_FOUND.code, NOT_FOUND.message, null);

  await appendAuditEvent({
    orgId,
    employeeId: employee.id,
    credentialId: updated.credentialId ?? null,
    actorEmail: approver ?? undefined,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `${change}（管理MCP・人承認）${noticeSuffix}`,
    metadata: {
      ...auditBase,
      event: tool === ALLOWED_ACCOUNTS_ADD_TOOL ? "employee.allowed_accounts.added" : "employee.allowed_accounts.removed",
      before,
      after,
      ...(tool === ALLOWED_ACCOUNTS_REMOVE_TOOL
        ? { slackIdentityRemains: slackRemains, ...(slackRemains ? { slackIdentityNoticeJa: SLACK_IDENTITY_REMAINS_NOTICE_JA } : {}) }
        : {}),
    },
  });
  return {
    ok: true,
    employeeId: employee.id,
    changed: true,
    summaryJa: `${change}しました（${before.length} 件 → ${after.length} 件）。${noticeSuffix}`,
    ...noticeOut,
  };
}
