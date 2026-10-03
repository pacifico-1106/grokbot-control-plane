/**
 * Admin MCP: setup.slackAuthorizeLink.issue (SLACK_AUTHORIZE_LINK_ENABLED, default OFF).
 *
 * always_human: the ticket is queued here; the link is created and delivered
 * only in fulfillment (fulfill-admin). Optional SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY
 * (default OFF, 要判断) issues without a ticket only for an already-linked
 * employee whose token lacks exactly im:write (link pinned to the same Slack
 * user + team), never for an employee bound to the calling admin agent.
 *
 * deliverTo "employee" (default) sends the link to the employee's own Slack U…
 * (only when exactly one; else approver, reason recorded) and notifies the
 * approver; "approver" keeps the original behavior.
 *
 * Org always from the credential. No token / URL is accepted or returned: the
 * result says only where the link was delivered.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import {
  approvalInboxAllowedUsers,
  probeSlackTokenScopes,
  rejectUnsafeArgs,
  resolveSlackApprovalInbox,
  type ToolOutcome,
} from "@/lib/admin-mcp/slack-dm-setup";
import { getBinding } from "@/lib/data/bindings";
import { getEmployee } from "@/lib/data/employees";
import { getEmployeeSlackIdentity, getLinkedSlackUserToken } from "@/lib/data/slack-identities";
import { pickApprovalDeliveryUser } from "@/lib/slack/approval-dm-open";
import {
  authorizeLinkPins,
  chooseAuthorizeLinkDelivery,
  employeeDeliveryCandidates,
  issueSlackAuthorizeLink,
  parseAuthorizeLinkDeliverTo,
  type IssueAuthorizeLinkResult,
} from "@/lib/slack/authorize-link";
import {
  isSlackAuthorizeLinkEnabled,
  isSlackAuthorizeLinkReissueAuditOnlyEnabled,
} from "@/lib/slack/authorize-link-flags";
import { isSlackUserScopeImWriteEnabled } from "@/lib/slack/dm-autoroute-flags";
import { slackUserScopesForAuthorize } from "@/lib/slack/oauth";

export const SLACK_AUTHORIZE_LINK_TOOL = "setup.slackAuthorizeLink.issue" as const;
export const SLACK_AUTHORIZE_LINK_ALLOWED_ARGS = ["employeeId", "inboxId", "deliveryUserId", "deliverTo", "jobId", "approvalId"] as const;

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome {
  return { kind: "result", data: { ok: false, code, message, ...extra }, isError: true };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Public, URL-free view of an issue result (MCP output / fulfillment). */
export function publicIssueResult(result: Extract<IssueAuthorizeLinkResult, { ok: true }>, extra: Record<string, unknown> = {}) {
  const to = result.deliveredTo;
  return {
    ok: true,
    employeeId: result.employeeId,
    linkId: result.linkId,
    expiresAt: result.expiresAt,
    deliveredTo: to,
    deliveryTarget: to.target,
    deliveryFallbackReason: to.fallbackReason,
    pinned: result.pinned,
    urlReturned: false,
    imWriteRequested: isSlackUserScopeImWriteEnabled(),
    nextStepJa: issueNextStepJa(result),
    ...extra,
  };
}

export function issueNextStepJa(result: Extract<IssueAuthorizeLinkResult, { ok: true }>): string {
  const to = result.deliveredTo;
  const where =
    to.target === "employee"
      ? `社員本人の Slack（${to.deliveryUserId}）に承認アプリの DM でリンクを送り、承認者（${to.approverUserId}）にも送った旨を通知しました。` +
        `社員本人が自分の Slack にログインしたブラウザで開き「許可する」を押すだけです（24時間・1回限り）。`
      : `承認者（${to.deliveryUserId}）に承認アプリの DM でリンクを送りました` +
        `${to.fallbackReason ? `（社員本人には送れないため: ${to.fallbackReason}）` : ""}。` +
        `社員本人の Slack アカウントでログインしたブラウザで開き「許可する」を押すだけです（24時間・1回限り）。`;
  return `${where}完了すると変更履歴に結び付いた Slack ユーザーが記録され、承認者に通知されます。`;
}

/** Exactly im:write missing (scopes readable, token valid). */
async function onlyLacksImWrite(employeeId: string): Promise<boolean> {
  if (!isSlackUserScopeImWriteEnabled()) return false;
  const probe = await probeSlackTokenScopes(await getLinkedSlackUserToken(employeeId));
  if (!probe.ok || !probe.scopes) return false;
  const wanted = slackUserScopesForAuthorize().split(",");
  const missing = wanted.filter((scope) => !probe.scopes!.includes(scope));
  return missing.length === 1 && missing[0] === "im:write";
}

export async function handleSlackAuthorizeLinkIssue(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const unsafe = rejectUnsafeArgs(args, SLACK_AUTHORIZE_LINK_ALLOWED_ARGS);
  if (unsafe) return unsafe;
  if (!isSlackAuthorizeLinkEnabled()) {
    return fail("authorize_link_flag_off", "SLACK_AUTHORIZE_LINK_ENABLED が OFF です（運営が migration 適用後に ON）。");
  }
  const orgId = cred.orgId;
  const employeeId = str(args.employeeId);
  const inboxId = str(args.inboxId);
  const deliveryUserId = str(args.deliveryUserId);
  const deliverToRaw = args.deliverTo;
  const deliverTo = deliverToRaw === undefined || deliverToRaw === null || deliverToRaw === "" ? null : parseAuthorizeLinkDeliverTo(deliverToRaw);
  if (deliverToRaw !== undefined && deliverToRaw !== null && deliverToRaw !== "" && !deliverTo) {
    return fail("invalid_deliver_to", "deliverTo は \"employee\"（既定・社員本人の Slack に送る）か \"approver\"（承認者に送る）です。");
  }
  if (!employeeId || !SAFE_ID_RE.test(employeeId)) return fail("employee_id_required", "employeeId を指定してください。");
  if (inboxId && !SAFE_ID_RE.test(inboxId)) return fail("invalid_inbox_id", "inboxId が不正です。");
  if (deliveryUserId && !SLACK_USER_ID_RE.test(deliveryUserId)) {
    return fail("invalid_slack_user_id", "deliveryUserId は Slack の user ID（U…）で指定してください。");
  }
  const employee = await getEmployee(employeeId, orgId);
  if (!employee || employee.orgId !== orgId) return fail("employee_not_found", "この組織の AI 社員ではありません。");
  const pins = await authorizeLinkPins(orgId, employee);
  if (!pins.ok) {
    return fail(pins.code, pins.messageJa, pins.nextStepJa ? { nextStepJa: pins.nextStepJa, allowedAccountsAdminTool: null } : {});
  }
  const inbox = await resolveSlackApprovalInbox(orgId, inboxId);
  if ("kind" in inbox) return inbox;
  if (!inbox.hasCredentials) {
    return fail("bot_token_required", "承認口に Bot token がありません。ダッシュボードで人が入力してください（チャットに貼らない）。");
  }
  const picked = pickApprovalDeliveryUser(approvalInboxAllowedUsers(inbox), deliveryUserId);
  if (!picked.ok) return fail(picked.code, picked.messageJa);

  if (isSlackAuthorizeLinkReissueAuditOnlyEnabled() && pins.linked && pins.expectedSlackUserId) {
    const binding = await getBinding(employee.id);
    const selfBound = Boolean(binding?.grokBotAgentId && binding.grokBotAgentId === cred.grokBotAgentId);
    const identity = await getEmployeeSlackIdentity(employee.id);
    if (!selfBound && identity?.orgId === orgId && identity.status === "linked" && (await onlyLacksImWrite(employee.id))) {
      const issued = await issueSlackAuthorizeLink({
        orgId,
        employeeId: employee.id,
        inboxId: inbox.id,
        deliveryUserId: picked.userId,
        approvalId: null,
        via: "audit_only",
        actor: { adminAgentId: cred.adminAgentId, grokBotAgentId: cred.grokBotAgentId },
        deliverTo,
      });
      if (!issued.ok) return fail(issued.code, issued.messageJa, issued.missingScope ? { missingScope: issued.missingScope } : {});
      return { kind: "result", data: publicIssueResult(issued, { auditOnly: true }) };
    }
  }

  const pinText = pins.expectedSlackUserId ? `Slack ${pins.expectedSlackUserId}` : "許可アカウントのいずれか";
  const choice = chooseAuthorizeLinkDelivery({ requested: deliverTo, employeeSlackUserIds: employeeDeliveryCandidates(pins, employee) });
  const whereText =
    choice.target === "employee"
      ? `承認アプリの DM で社員本人（${choice.employeeUserId}）に送り、承認者 ${picked.userId} に送った旨を通知する`
      : `承認アプリの DM で承認者 ${picked.userId} に送る${choice.fallbackReason ? `（社員本人の Slack が 1 つに決まらないため: ${choice.fallbackReason}）` : ""}`;
  return {
    kind: "queue",
    queuedArgs: {
      employeeId: employee.id,
      inboxId: inbox.id,
      deliveryUserId: picked.userId,
      expectedSlackUserId: pins.expectedSlackUserId,
      linked: pins.linked,
      ...(deliverTo ? { deliverTo } : {}),
    },
    summary:
      `AI社員「${employee.displayName}」の Slack 再認可リンク（24時間・1回限り・${pinText} と承認アプリのワークスペースに固定）を、` +
      `${whereText}ことを人が確認します（リンクの URL は管理エージェントに返しません）`,
  };
}

/** Fulfillment of a human-approved setup.slackAuthorizeLink.issue. Org from the approval row. */
export async function fulfillSlackAuthorizeLinkIssue(input: {
  orgId: string;
  approvalId: string;
  args: Record<string, unknown>;
}): Promise<IssueAuthorizeLinkResult> {
  return issueSlackAuthorizeLink({
    orgId: input.orgId,
    employeeId: str(input.args.employeeId),
    inboxId: str(input.args.inboxId),
    deliveryUserId: str(input.args.deliveryUserId),
    approvalId: input.approvalId,
    via: "ticket",
    approvedExpectedSlackUserId:
      typeof input.args.expectedSlackUserId === "string" && input.args.expectedSlackUserId ? input.args.expectedSlackUserId : null,
    deliverTo: parseAuthorizeLinkDeliverTo(input.args.deliverTo),
  });
}
