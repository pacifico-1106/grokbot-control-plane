/**
 * Item C (木村 2026-10-09, triage #5 / T6) — SLACK_U_TO_DM_SEND_ENABLED (default OFF),
 * effective only with SLACK_DM_AUTOROUTE_ENABLED ON (already ON in production).
 *
 * A Slack send whose channel field holds a U…/W… user id (e.g. comm.reply
 * `slackChannelId: "U…"`) is mapped to the employee's INTERNAL 1:1 DM route:
 *
 * - Only when the party ledger (org_parties) of the EMPLOYEE's org has that
 *   user as kind=slack_user, audience=internal. The org comes from the
 *   credential-resolved employee, never from the request; the internal-ness
 *   comes from the ledger only (no request field, no team rule).
 * - The DM is opened with #234's syncAutoDmRoutesForEmployee (employee user
 *   token, users.info verdict: guest / other workspace / stranger / bot /
 *   deleted → refuse; conversations.open; existing external classification /
 *   another employee's route are never overwritten), in strict mode: the
 *   opened conversation must be `is_im` with `user` === that U….
 * - The returned D… is checked again against the stored route (same org,
 *   same employee, same counterpart) and the channel ledger (internal, not
 *   mixed) before the request is rewritten.
 * - The rewrite only swaps the channel fields holding that U… for the D…, at
 *   the destination-resolution layer, before egress. Egress, topic gate,
 *   dedup and thread single-flight then all see the same D… (no change to
 *   their code).
 * - Anyone else, a bot-posting employee, missing im:write, or a failed /
 *   mismatched conversations.open → stop (nothing sent) with code + nextStep.
 *   The caller writes an audit row with ids only.
 * - A U… only in the user / speaker fields is untouched: the existing
 *   validateSlackPostDestination fail-closed rule (dm=true required) stays.
 *
 * Flag OFF: returns `unchanged` before any lookup (no Slack call, no DB read).
 */
import { getOrgChannel, getOrgParty } from "@/lib/data/directory";
import { getSlackImEmployeeRoute, isSlackImChannelId } from "@/lib/data/slack-im-routes";
import { parseConversationContext } from "@/lib/gateway/audience";
import { isSlackUToDmSendEnabled } from "@/lib/slack/dm-autoroute-flags";
import { syncAutoDmRoutesForEmployee } from "@/lib/slack/dm-autoroute";
import type { Employee, GatewayInvokeRequest } from "@/lib/types";

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,31}$/;

export type SlackUserRecipientStopCode =
  | "slack_recipient_not_internal_party"
  | "slack_recipient_not_eligible"
  | "slack_dm_autoroute_identity_required"
  | "slack_dm_reauthorize_required"
  | "slack_dm_open_failed"
  | "slack_dm_route_mismatch";

export type SlackUserRecipientResolution =
  | { kind: "unchanged" }
  | { kind: "resolved"; body: GatewayInvokeRequest; channelId: string; counterpartSlackUserId: string }
  | {
      kind: "stopped";
      httpStatus: number;
      code: SlackUserRecipientStopCode;
      /** Short machine reason (e.g. guest_user, missing_scope_im_write). Never a value. */
      reason: string;
      counterpartSlackUserId: string;
      messageJa: string;
      nextStep: string;
      nextStepJa: string;
      retryable: boolean;
    };

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function s(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The effective Slack channel field (same precedence as parseConversationContext), if it is a user id. */
export function slackUserIdInChannelField(body: GatewayInvokeRequest): string | null {
  const conv = rec(body.conversation);
  const args = rec(body.args);
  const b = body as unknown as Record<string, unknown>;
  const channel = s(conv.slackChannelId) || s(b.slackChannelId) || s(args.slackChannelId) || s(args.channelId) || s(args.channel);
  return SLACK_USER_ID.test(channel) ? channel : null;
}

/** Copy of the body with every channel field equal to `userId` replaced by `channelId`. */
function rewriteChannel(body: GatewayInvokeRequest, userId: string, channelId: string): GatewayInvokeRequest {
  const swap = (value: unknown) => (s(value) === userId ? channelId : value);
  const next = { ...body } as unknown as Record<string, unknown>;
  if (body.conversation && typeof body.conversation === "object") {
    const conv = { ...(body.conversation as unknown as Record<string, unknown>) };
    if ("slackChannelId" in conv) conv.slackChannelId = swap(conv.slackChannelId);
    next.conversation = conv;
  }
  if ("slackChannelId" in next) next.slackChannelId = swap(next.slackChannelId);
  if (body.args && typeof body.args === "object") {
    const args = { ...(body.args as Record<string, unknown>) };
    for (const key of ["slackChannelId", "channelId", "channel"]) {
      if (key in args) args[key] = swap(args[key]);
    }
    next.args = args;
  }
  return next as unknown as GatewayInvokeRequest;
}

const REDIRECT_JA =
  "社外・ゲストの人へは、共有チャンネル（C…）を宛先にするか、conversation.slackUserId に U… を指定して dm=true を付けてください（区分に応じて承認を経由します）。";
const REDIRECT_EN =
  "For an external or guest user, send to a shared channel (C…) or put the U… in conversation.slackUserId with dm=true (it goes through approval as its class requires).";

function stop(
  code: SlackUserRecipientStopCode,
  reason: string,
  counterpart: string
): Extract<SlackUserRecipientResolution, { kind: "stopped" }> {
  const base = { kind: "stopped" as const, code, reason, counterpartSlackUserId: counterpart };
  switch (code) {
    case "slack_recipient_not_internal_party":
      return {
        ...base,
        httpStatus: 403,
        retryable: false,
        messageJa: `宛先 ${counterpart} は相手台帳で社内（internal の slack_user）として登録されていないため、DM に引き当てずに止めました（送信していません）。`,
        nextStepJa: `社内の人なら、管理者に Admin MCP の parties.upsert（kind=slack_user, audience=internal）で登録を依頼してから再送してください。${REDIRECT_JA}`,
        nextStep: `If this is an internal person, ask an admin to register them with Admin MCP parties.upsert (kind=slack_user, audience=internal), then retry. ${REDIRECT_EN}`,
      };
    case "slack_recipient_not_eligible":
      return {
        ...base,
        httpStatus: 403,
        retryable: false,
        messageJa: `宛先 ${counterpart} は Slack 上で社内の正規メンバーと確認できません（${reason}）。DM に引き当てずに止めました（送信していません）。`,
        nextStepJa: `台帳の登録が誤りなら管理者に parties.upsert で修正を依頼してください。${REDIRECT_JA}`,
        nextStep: `If the ledger entry is wrong, ask an admin to fix it with parties.upsert. ${REDIRECT_EN}`,
      };
    case "slack_dm_autoroute_identity_required":
      return {
        ...base,
        httpStatus: 403,
        retryable: false,
        messageJa: `社内 DM ルートは社員の Slack 本人連携（postingAs=user）で送ります。この社員は本人連携がないか postingAs=user ではありません（${reason}）。送信していません。`,
        nextStepJa:
          "管理者が社員証画面で Slack 本人連携（im:write を含む）を行い postingAs=user にしてから再送してください。アプリ DM で送るなら conversation.slackUserId に U… を指定し dm=true を付けてください。",
        nextStep:
          "Ask an admin to link the employee's Slack identity (with im:write) and set postingAs=user, then retry. To send as an app DM instead, put the U… in conversation.slackUserId with dm=true.",
      };
    case "slack_dm_reauthorize_required":
      return {
        ...base,
        httpStatus: 409,
        retryable: false,
        messageJa: `社員の Slack user token に im:write がない（または確認できない）ため、DM を開けません（${reason}）。送信していません。`,
        nextStepJa:
          "管理者が SLACK_USER_SCOPE_IM_WRITE を ON にしたうえで、Admin MCP の setup.slackAuthorizeLink.issue で再認可リンクを発行し、社員の Slack で im:write を含めて再認可してから再送してください。",
        nextStep:
          "Re-authorize the employee's Slack user token with im:write (admin: SLACK_USER_SCOPE_IM_WRITE ON, then Admin MCP setup.slackAuthorizeLink.issue), then retry.",
      };
    case "slack_dm_route_mismatch":
      return {
        ...base,
        httpStatus: 409,
        retryable: false,
        messageJa: `Slack が返した会話を ${counterpart} との 1:1 の社内 DM と確認できないため止めました（${reason}）。送信していません。`,
        nextStepJa:
          "管理者に Admin MCP の setup.slackDmApprovalStatus でこの相手との DM ルートとチャンネル分類を確認してもらってください。",
        nextStep: "Ask an admin to check this DM route and its channel classification (Admin MCP setup.slackDmApprovalStatus).",
      };
    case "slack_dm_open_failed":
    default:
      return {
        ...base,
        code: "slack_dm_open_failed",
        httpStatus: 409,
        retryable: true,
        messageJa: `Slack で DM を開けませんでした（${reason}）。送信していません。`,
        nextStepJa:
          "時間をおいて再送してください。続く場合は管理者に Admin MCP の setup.slackDmApprovalStatus で状態を確認してもらってください。",
        nextStep: "Retry later. If it persists, ask an admin to check Admin MCP setup.slackDmApprovalStatus.",
      };
  }
}

const NOT_ELIGIBLE = new Set([
  "slack_connect_stranger",
  "other_workspace",
  "guest_user",
  "bot_user",
  "user_deleted",
  "user_undeterminable",
  "team_undeterminable",
]);
const MISMATCH = new Set([
  "not_a_dm",
  "dm_user_mismatch",
  "dm_user_unverified",
  "dm_externally_shared",
  "channel_classified_external",
  "route_conflict",
  "connect_cannot_be_internal",
]);
const IDENTITY = new Set(["employee_not_active", "identity_not_linked", "identity_team_unknown", "employee_not_found"]);
const AUTH_ERRORS = /^auth_test_(invalid_auth|not_authed|token_revoked|token_expired|account_inactive)$/;

function codeForReason(reason: string): SlackUserRecipientStopCode {
  if (reason === "counterpart_not_internal_party") return "slack_recipient_not_internal_party";
  if (NOT_ELIGIBLE.has(reason) || (reason.startsWith("users_info_") && !reason.endsWith("missing_scope"))) {
    return "slack_recipient_not_eligible";
  }
  if (MISMATCH.has(reason)) return "slack_dm_route_mismatch";
  if (IDENTITY.has(reason)) return "slack_dm_autoroute_identity_required";
  if (
    reason.startsWith("missing_scope") ||
    reason.endsWith("_missing_scope") ||
    reason === "token_scopes_unknown" ||
    reason === "user_token_unavailable" ||
    reason === "token_identity_mismatch" ||
    AUTH_ERRORS.test(reason)
  ) {
    return "slack_dm_reauthorize_required";
  }
  return "slack_dm_open_failed";
}

export async function resolveSlackUserRecipient(input: {
  orgId: string;
  employee: Employee;
  body: GatewayInvokeRequest;
}): Promise<SlackUserRecipientResolution> {
  // SLACK_U_TO_DM_SEND_ENABLED AND SLACK_DM_AUTOROUTE_ENABLED; otherwise today's main.
  if (!isSlackUToDmSendEnabled()) return { kind: "unchanged" };
  const counterpart = slackUserIdInChannelField(input.body);
  if (!counterpart) return { kind: "unchanged" };
  const ctx = parseConversationContext(input.body, input.orgId);
  if (!ctx || ctx.surface !== "slack") return { kind: "unchanged" };

  const orgId = (input.orgId || "").trim();
  const employee = input.employee;
  if (!orgId || employee.orgId !== orgId) return stop("slack_dm_autoroute_identity_required", "employee_org_mismatch", counterpart);

  // Internal-ness from the ledger of the employee's org only.
  const party = await getOrgParty(orgId, "slack_user", counterpart);
  if (!party || party.orgId !== orgId || party.kind !== "slack_user" || party.audience !== "internal") {
    return stop("slack_recipient_not_internal_party", party ? `party_${party.audience}` : "party_not_found", counterpart);
  }
  if (employee.postingAs !== "user") return stop("slack_dm_autoroute_identity_required", "posting_as_not_user", counterpart);

  const result = await syncAutoDmRoutesForEmployee({
    orgId,
    employeeId: employee.id,
    trigger: "send_recipient",
    onlyCounterpart: counterpart,
    requireImWithCounterpart: true,
  });
  if (result.status === "flag_off") return { kind: "unchanged" };
  const item = result.items[0];
  const reason = (item?.reason || result.reason || "unexpected_error").slice(0, 64);
  if (!item || (item.outcome !== "created" && item.outcome !== "already_routed") || !item.channelId) {
    return stop(codeForReason(reason), reason, counterpart);
  }

  // Re-check the resolved D… against what is stored (route + channel ledger).
  const channelId = item.channelId;
  if (!isSlackImChannelId(channelId)) return stop("slack_dm_route_mismatch", "not_a_dm", counterpart);
  const route = await getSlackImEmployeeRoute(orgId, channelId);
  if (
    !route ||
    route.orgId !== orgId ||
    route.employeeId !== employee.id ||
    (route.counterpartSlackUserId || "").toUpperCase() !== counterpart.toUpperCase()
  ) {
    return stop("slack_dm_route_mismatch", "route_recheck_failed", counterpart);
  }
  const channel = await getOrgChannel(orgId, "slack", channelId);
  if (!channel || channel.classification !== "internal" || channel.mixed) {
    return stop("slack_dm_route_mismatch", "channel_recheck_failed", counterpart);
  }
  return {
    kind: "resolved",
    body: rewriteChannel(input.body, counterpart, channelId),
    channelId,
    counterpartSlackUserId: counterpart,
  };
}
