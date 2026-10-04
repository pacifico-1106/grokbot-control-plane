/**
 * Admin MCP: employees.postingIdentity.set — switch an AI employee's Slack
 * posting identity (employees.posting_as: "bot" | "user").
 *
 * always_human (approvalClass admin): the ticket is queued here; the change is
 * written only in fulfillment (fulfill-admin) after a human approves. No
 * feature flag: the always_human ticket is the gate (same as policy.patch).
 *
 * Security invariants (tests in posting-identity-tool.test.ts):
 * - orgId ALWAYS comes from the admin credential (queue) / the approval row
 *   (fulfillment). No orgId argument; unknown arguments are rejected.
 * - Another org's employee gets the same `employee_not_found` as a missing id.
 * - The admin agent cannot switch the badge bound to its own Grok Bot.
 * - Switching to "user" requires, both at propose time AND right before the
 *   write after approval: a LINKED Slack identity of the same org with a saved
 *   user token (OAuth / #240 re-authorize link), a token Slack still accepts,
 *   and granted scopes (auth.test x-oauth-scopes) that include chat:write.
 *   Anything else refuses without a change: user_token_missing /
 *   user_token_invalid / user_token_scope_check_failed / missing_scope_chat_write.
 * - Also for "user": when allowedAccounts has at least one Slack row, the
 *   linked Slack user ID must be one of them (slack_account_not_allowed).
 * - Every run re-checks everything; a run refused with one of the codes above
 *   may be re-run with the same approvalId (POSTING_IDENTITY_RETRYABLE_REFUSAL_CODES).
 * - Switching to "bot" needs no token check (no Slack call).
 * - The token is a local variable only (auth.test probe); it is never put in
 *   the ticket, the MCP result, or the audit row.
 * - Same write as the dashboard (writeEmployeePostingAs) and an admin-class
 *   audit row: from / to, actor (admin agent), approver, approvalId.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import {
  isEmployeesAllowedAccountsAdminToolAvailable,
  requesterOf,
  selfBound,
} from "@/lib/admin-mcp/allowed-accounts-tools";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { probeSlackTokenScopes, rejectUnsafeArgs } from "@/lib/admin-mcp/slack-dm-setup";
import { appendAuditEvent } from "@/lib/data/audit";
import { getBinding } from "@/lib/data/bindings";
import { getEmployee } from "@/lib/data/employees";
import { getEmployeeSlackIdentity, getLinkedSlackUserToken } from "@/lib/data/slack-identities";
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { employeePolicyWriteFailure } from "@/lib/employees/policy-errors";
import { employeeAllowsSlackUser } from "@/lib/employees/posting-as";
import {
  POSTING_AS_LABEL_JA,
  currentPostingAs,
  parsePostingAsStrict,
  postingAsChangeMetadata,
  writeEmployeePostingAs,
} from "@/lib/employees/posting-identity";
import { isSlackAuthorizeLinkEnabled } from "@/lib/slack/authorize-link-flags";
import type { ApprovalRequest, Employee, PostingAs } from "@/lib/types";

export const POSTING_IDENTITY_SET_TOOL = "employees.postingIdentity.set" as const;
export const POSTING_IDENTITY_ALLOWED_ARGS = ["employeeId", "postingAs", "jobId", "approvalId"] as const;

/** User-token scope needed to post as the employee (chat.postMessage). */
export const POSTING_IDENTITY_REQUIRED_USER_SCOPE = "chat:write";

export type PostingIdentityRefusalCode =
  | "user_token_missing"
  | "slack_account_not_allowed"
  | "user_token_invalid"
  | "user_token_scope_check_failed"
  | "missing_scope_chat_write";

/**
 * Pre-write refusals that every run re-checks from scratch: after a run fails
 * with one of these, re-invoking the same approvalId runs the fulfillment
 * again (lib/approvals/execution.ts retryableByTool). Any other failure,
 * notably a failed write, stays "uncertain" and is not re-run.
 */
export const POSTING_IDENTITY_RETRYABLE_REFUSAL_CODES: readonly PostingIdentityRefusalCode[] = [
  "user_token_missing",
  "slack_account_not_allowed",
  "user_token_invalid",
  "user_token_scope_check_failed",
  "missing_scope_chat_write",
];

/** auth.test errors that mean "this token is no longer usable" (re-authorize). */
const TOKEN_UNUSABLE_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

const NOT_FOUND = { code: "employee_not_found", message: "AI社員が見つかりません" } as const;

function reauthorizeNextStepJa(employeeId: string): string {
  return isSlackAuthorizeLinkEnabled()
    ? `setup.slackAuthorizeLink.issue（employeeId=${employeeId}）で再認可リンクを社員本人に送り、本人が「許可する」を押してから、もう一度 ${POSTING_IDENTITY_SET_TOOL} を依頼してください。`
    : `ダッシュボードの AI社員詳細 →「Slack 連携（Authorize）」で社員本人が連携し直してから、もう一度 ${POSTING_IDENTITY_SET_TOOL} を依頼してください。`;
}

function displayNameJa(employee: Employee): string {
  const name = (employee.displayName || "").replace(/\s+/g, " ").trim() || employee.id;
  return name.length > 40 ? `${name.slice(0, 40)}…` : name;
}

function labelJa(postingAs: PostingAs, slackUserId?: string | null): string {
  return postingAs === "user" && slackUserId ? `${POSTING_AS_LABEL_JA.user}（Slack ${slackUserId}）` : POSTING_AS_LABEL_JA[postingAs];
}

function changeJa(employee: Employee, from: PostingAs, to: PostingAs, slackUserId?: string | null): string {
  return `社員「${displayNameJa(employee)}」の Slack 投稿名義を ${labelJa(from)} → ${labelJa(to, slackUserId)} に切り替え`;
}

// ---------------------------------------------------------------------------
// User-token readiness (propose time and right before the write)
// ---------------------------------------------------------------------------

export type UserPostingReadiness =
  | { ok: true; slackUserId: string }
  | {
      ok: false;
      code: PostingIdentityRefusalCode;
      messageJa: string;
      nextStepJa: string;
      extra: Record<string, unknown>;
    };

/**
 * Can this employee post as itself right now? Reads the identity of the
 * employee's own org only; the user token stays local (auth.test probe).
 * Fail-closed: anything not positively "linked + accepted + chat:write" refuses.
 */
export async function checkUserPostingReadiness(employee: Employee): Promise<UserPostingReadiness> {
  const nextStepJa = reauthorizeNextStepJa(employee.id);
  const missing: UserPostingReadiness = {
    ok: false,
    code: "user_token_missing",
    messageJa:
      "本人として投稿するための Slack ユーザートークンが保存されていません（未連携、または再認可が必要です）。変更していません。",
    nextStepJa,
    extra: {},
  };
  const identity = await getEmployeeSlackIdentity(employee.id).catch(() => null);
  if (!identity || identity.orgId !== employee.orgId || identity.status !== "linked" || !identity.slackUserId) return missing;

  // allowedAccounts (木村 decision): when the badge lists any Slack account,
  // the linked Slack user must be one of them. Same match as binding
  // (bindEmployeeSlackIdentity → employeeAllowsSlackUser): service "slack"
  // case-insensitive, accountId exactly the U… / W… (trimmed). No Slack row → no check.
  const slackRows = normalizeAllowedAccounts(employee.allowedAccounts).filter((row) => row.service.toLowerCase() === "slack");
  if (slackRows.length > 0 && !employeeAllowsSlackUser(employee.allowedAccounts, identity.slackUserId)) {
    const slackUserId = identity.slackUserId.trim();
    return {
      ok: false,
      code: "slack_account_not_allowed",
      messageJa: `連携している Slack アカウント（${slackUserId}）が、この社員証の許可アカウント（Slack ${slackRows.length} 件）にありません。変更していません。`,
      nextStepJa: isEmployeesAllowedAccountsAdminToolAvailable()
        ? `employees.allowedAccounts.add（provider: slack, accountId: ${slackUserId}）で許可アカウントに追加するか、許可アカウントにある Slack アカウントで連携し直してから、もう一度 ${POSTING_IDENTITY_SET_TOOL} を依頼してください。`
        : `ダッシュボードの AI社員ページ「ブラウザ・外部アカウント」で Slack ${slackUserId} を追加するか、許可アカウントにある Slack アカウントで連携し直してから、もう一度 ${POSTING_IDENTITY_SET_TOOL} を依頼してください。`,
      extra: { slackUserId, allowedSlackAccountCount: slackRows.length },
    };
  }
  const token = await getLinkedSlackUserToken(employee.id).catch(() => "");
  if (!token) return missing;

  const probe = await probeSlackTokenScopes(token);
  if (!probe.ok && TOKEN_UNUSABLE_ERRORS.has(probe.error)) {
    return {
      ok: false,
      code: "user_token_invalid",
      messageJa: `保存されている Slack ユーザートークンが Slack に拒否されました（${probe.error}）。変更していません。`,
      nextStepJa,
      extra: { slackError: probe.error },
    };
  }
  if (!probe.ok || !probe.scopes) {
    return {
      ok: false,
      code: "user_token_scope_check_failed",
      messageJa: `Slack ユーザートークンの権限（scope）を確認できませんでした${probe.ok ? "" : `（${probe.error}）`}。確認できないため変更していません。`,
      nextStepJa: `時間をおいて、もう一度 ${POSTING_IDENTITY_SET_TOOL} を依頼してください。続く場合は ${nextStepJa}`,
      extra: probe.ok ? {} : { slackError: probe.error },
    };
  }
  if (!probe.scopes.includes(POSTING_IDENTITY_REQUIRED_USER_SCOPE)) {
    return {
      ok: false,
      code: "missing_scope_chat_write",
      messageJa: `Slack ユーザートークンに ${POSTING_IDENTITY_REQUIRED_USER_SCOPE} がないため、本人として投稿できません。変更していません。`,
      nextStepJa,
      extra: { missingScopes: [POSTING_IDENTITY_REQUIRED_USER_SCOPE] },
    };
  }
  return { ok: true, slackUserId: identity.slackUserId };
}

// ---------------------------------------------------------------------------
// Tool handler (queue phase) — called from callAdminMcpTool
// ---------------------------------------------------------------------------

export type PostingIdentityToolOutcome =
  | { kind: "result"; data: Record<string, unknown>; isError?: boolean }
  | { kind: "queue"; queuedArgs: Record<string, unknown>; summary: string; title: string };

function fail(code: string, message: string, extra: Record<string, unknown> = {}): PostingIdentityToolOutcome {
  return { kind: "result", data: { ok: false, code, message, ...extra }, isError: true };
}

export async function handlePostingIdentityTool(
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<PostingIdentityToolOutcome> {
  const unsafe = rejectUnsafeArgs(args, POSTING_IDENTITY_ALLOWED_ARGS);
  if (unsafe) return unsafe as PostingIdentityToolOutcome;
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  if (!employeeId || args.postingAs === undefined) return fail("missing_required_fields", "employeeId と postingAs が必要です");
  const to = parsePostingAsStrict(args.postingAs);
  if (!to) return fail("invalid_posting_as", 'postingAs は "bot"（会社のBot）か "user"（本人）です');

  // Org from the credential only.
  const employee = await getEmployee(employeeId, cred.orgId);
  if (!employee || employee.orgId !== cred.orgId) return fail(NOT_FOUND.code, NOT_FOUND.message);
  if (employee.status === "suspended") return fail("employee_terminated", "この AI 社員は停止されています。");
  const binding = await getBinding(employee.id);
  if (selfBound(cred.grokBotAgentId, binding?.grokBotAgentId)) {
    return fail("cannot_target_self", "管理エージェントは自分の社員証の投稿名義を変更できません。");
  }

  const from = currentPostingAs(employee);
  if (from === to) {
    return {
      kind: "result",
      data: {
        ok: true,
        code: "already_set",
        changed: false,
        employeeId: employee.id,
        postingAs: to,
        message: `社員「${displayNameJa(employee)}」の Slack 投稿名義は既に ${labelJa(to)} です（変更なし・承認不要）。`,
      },
    };
  }

  let slackUserId: string | null = null;
  if (to === "user") {
    const ready = await checkUserPostingReadiness(employee);
    if (!ready.ok) return fail(ready.code, ready.messageJa, { nextStepJa: ready.nextStepJa, ...ready.extra });
    slackUserId = ready.slackUserId;
  }
  return {
    kind: "queue",
    title: "AI社員の Slack 投稿名義の切り替え",
    queuedArgs: { employeeId: employee.id, postingAs: to },
    summary:
      `${changeJa(employee, from, to, slackUserId)}ます。承認すると反映されます` +
      (to === "user" ? "（反映の直前に、本人の Slack ユーザートークンと chat:write をもう一度確認します）。" : "。"),
  };
}

// ---------------------------------------------------------------------------
// Fulfillment (human approved) — called from fulfillApprovedAdmin
// ---------------------------------------------------------------------------

export type PostingIdentityFulfillment =
  | { ok: true; employeeId: string; changed: boolean; summaryJa: string; nextStepJa?: string }
  | { ok: false; code: string; messageJa: string; nextStepJa?: string; employeeId?: string };

export async function fulfillPostingIdentityChange(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<PostingIdentityFulfillment> {
  const orgId = approval.orgId;
  const actor = requesterOf(approval);
  const approver = approval.resolvedBy ?? null;
  const tool = POSTING_IDENTITY_SET_TOOL;
  const to = parsePostingAsStrict(args.postingAs);
  const failWith = async (
    code: string,
    messageJa: string,
    employee: Employee | null,
    extra: { nextStepJa?: string; from?: PostingAs } = {}
  ): Promise<PostingIdentityFulfillment> => {
    await appendAuditEvent({
      orgId,
      employeeId: employee?.id ?? null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `Slack 投稿名義の切り替えを中止（${code}）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        event: "employee.posting_as.rejected",
        tool,
        approvalId: approval.id,
        code,
        ...(employee ? { employeeId: employee.id } : {}),
        ...(extra.from && to ? { from: extra.from, to } : {}),
        actor,
        approver,
      },
    }).catch(() => undefined);
    return {
      ok: false,
      code,
      messageJa,
      ...(extra.nextStepJa ? { nextStepJa: extra.nextStepJa } : {}),
      ...(employee ? { employeeId: employee.id } : {}),
    };
  };

  if (!to) return failWith("invalid_posting_as", 'postingAs は "bot" か "user" です。', null);
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  // Re-validate against the CURRENT state, in the approval's org only.
  const employee = employeeId ? await getEmployee(employeeId, orgId) : null;
  if (!employee || employee.orgId !== orgId) return failWith(NOT_FOUND.code, NOT_FOUND.message, null);
  if (employee.status === "suspended") return failWith("employee_terminated", "この AI 社員は停止されています。", employee);
  const binding = await getBinding(employee.id);
  if (selfBound(actor.grokBotAgentId, binding?.grokBotAgentId)) {
    return failWith("cannot_target_self", "依頼した管理エージェント自身の社員証は変更できません。", employee);
  }

  const from = currentPostingAs(employee);
  const auditBase = {
    auditClass: ADMIN_AUDIT_CLASS,
    tool,
    approvalId: approval.id,
    employeeId: employee.id,
    ...postingAsChangeMetadata(from, to),
    actor,
    approver,
  };
  if (from === to) {
    // Switched meanwhile (e.g. on the dashboard): idempotent, no second write.
    await appendAuditEvent({
      orgId,
      employeeId: employee.id,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `社員「${displayNameJa(employee)}」の Slack 投稿名義は既に ${labelJa(to)} のため変更なし（管理MCP・人承認）`,
      metadata: { ...auditBase, event: "employee.posting_as.unchanged" },
    });
    return {
      ok: true,
      employeeId: employee.id,
      changed: false,
      summaryJa: `社員「${displayNameJa(employee)}」の Slack 投稿名義は既に ${labelJa(to)} だったため、変更しませんでした。`,
    };
  }

  // Re-check right before the write: the token may have been unlinked or
  // re-authorized with fewer scopes while the ticket was pending.
  let slackUserId: string | null = null;
  if (to === "user") {
    const ready = await checkUserPostingReadiness(employee);
    if (!ready.ok) return failWith(ready.code, ready.messageJa, employee, { nextStepJa: ready.nextStepJa, from });
    slackUserId = ready.slackUserId;
  }

  const change = changeJa(employee, from, to, slackUserId);
  let updated: Awaited<ReturnType<typeof writeEmployeePostingAs>>;
  try {
    updated = await writeEmployeePostingAs({ orgId, employee, postingAs: to });
  } catch (error) {
    // Fail-closed: a failed write is never reported as applied (no change audit).
    const failure = employeePolicyWriteFailure(error);
    console.error(failure.code, tool, employee.id, error instanceof Error ? error.message : error);
    return failWith(failure.code, failure.messageJa, employee, { nextStepJa: failure.nextStepJa, from });
  }
  if (!updated) return failWith(NOT_FOUND.code, NOT_FOUND.message, null);

  await appendAuditEvent({
    orgId,
    employeeId: employee.id,
    credentialId: updated.credentialId ?? null,
    actorEmail: approver ?? undefined,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `${change}（管理MCP・人承認）`,
    metadata: {
      ...auditBase,
      event: "employee.posting_as.changed",
      ...(slackUserId ? { slackUserId } : {}),
    },
  });
  return {
    ok: true,
    employeeId: employee.id,
    changed: true,
    summaryJa: `${change}ました。`,
    nextStepJa:
      to === "user"
        ? "これから社員の Slack 投稿は本人のユーザートークンで出ます。setup.slackStatus で状態を確認できます。"
        : "これから社員の Slack 投稿は会社の Bot で出ます。setup.slackStatus で状態を確認できます。",
  };
}
