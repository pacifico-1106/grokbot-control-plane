/**
 * Slack voter binding validation for approval workflow.
 *
 * P0 Item 5: When SLACK_APPROVAL_STRICT is ON, Slack button presses require:
 * - Either non-empty allowedUserIds on the channel
 * - OR a valid approval_workflow_voter_bindings row for the presser
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export type VoterBindingCheckResult =
  | { ok: true; reason: string; memberId?: string }
  | { ok: false; reason: string };

/**
 * Check if a Slack user has a valid voter binding.
 *
 * Checks approval_workflow_voter_bindings for:
 * - Same org_id
 * - provider = 'slack'
 * - channel_key matches the notification channel id
 * - external_user_id matches the Slack user id
 * - Not revoked
 * - Not expired
 */
export async function checkSlackVoterBinding(
  orgId: string,
  channelId: string,
  slackUserId: string
): Promise<VoterBindingCheckResult> {
  if (!orgId || !channelId || !slackUserId) {
    return { ok: false, reason: "missing_parameters" };
  }

  if (isDemoMode()) {
    const { getDemoWorkflowVoterBinding } = await import("@/lib/approval-workflow/data");
    const memberId = getDemoWorkflowVoterBinding(orgId, {
      provider: "slack",
      channelKey: channelId,
      userId: slackUserId,
    });
    if (memberId) {
      return { ok: true, reason: "demo_voter_binding", memberId };
    }
    return { ok: false, reason: "no_voter_binding" };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, reason: "supabase_unavailable" };
  }

  const { data, error } = await admin
    .from("approval_workflow_voter_bindings")
    .select("member_id, expires_at, revoked_at")
    .eq("org_id", orgId)
    .eq("provider", "slack")
    .eq("channel_key", channelId)
    .eq("external_user_id", slackUserId)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    return { ok: false, reason: "binding_check_failed" };
  }

  if (!data) {
    return { ok: false, reason: "no_voter_binding" };
  }

  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return { ok: false, reason: "voter_binding_expired" };
  }

  return { ok: true, reason: "valid_voter_binding", memberId: data.member_id };
}

/**
 * Determine if a Slack user is authorized to press approval buttons.
 *
 * When SLACK_APPROVAL_STRICT is ON:
 * - If allowedUserIds is non-empty, user must be in the list
 * - OR user must have a valid voter binding
 *
 * When SLACK_APPROVAL_STRICT is OFF:
 * - Existing behavior: only check allowedUserIds if non-empty
 */
export async function isSlackUserAuthorizedForApproval(
  orgId: string,
  channelId: string,
  slackUserId: string,
  allowedUserIds: string[],
  strictMode: boolean
): Promise<{ authorized: boolean; reason: string }> {
  if (!strictMode) {
    if (allowedUserIds.length > 0) {
      if (slackUserId && allowedUserIds.includes(slackUserId)) {
        return { authorized: true, reason: "in_allowed_user_ids" };
      }
      return { authorized: false, reason: "not_in_allowed_user_ids" };
    }
    return { authorized: true, reason: "no_restrictions" };
  }

  if (allowedUserIds.length > 0) {
    if (slackUserId && allowedUserIds.includes(slackUserId)) {
      return { authorized: true, reason: "in_allowed_user_ids" };
    }
    return { authorized: false, reason: "not_in_allowed_user_ids" };
  }

  const bindingCheck = await checkSlackVoterBinding(orgId, channelId, slackUserId);
  if (bindingCheck.ok) {
    return { authorized: true, reason: bindingCheck.reason };
  }

  return {
    authorized: false,
    reason: "strict_mode_requires_allowed_user_ids_or_voter_binding",
  };
}
