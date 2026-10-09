/**
 * #289 review (木村 2026-10-09): who asked the admin agent to file a ticket.
 *
 * Admin-MCP tickets only know the admin agent (metadata.adminRequester), so
 * "the requester cannot approve" had nothing to compare against. The only
 * route to a human we can check server-side is the approver registration:
 * the admin agent passes the Slack user ID of the person who woke it
 * (requesterSlackUserId) and we map it to a member ONLY through an active
 * (verified, unexpired, unrevoked) Slack voter binding of THIS org whose
 * member is active. Anything else → "not identified" (never guessed).
 *
 * Limitation (stated on the card and in the PR): the Slack ID is declared by
 * the admin agent; the server cannot prove that this person, and not someone
 * else, asked. It identifies the requester honestly when the agent reports
 * it; it does not stop a requester who hides behind an agent that omits it.
 *
 * Option (c) (木村 2026-10-09 22:48): for members.promoteOwner with 2+ active
 * owners, an unidentified requester is refused at filing
 * (requester_not_identified). That closes "omits it" but not "declares
 * someone else's verified Slack ID" — the self-reported limit above remains.
 */
import { listVoterBindings } from "@/lib/approval-workflow/voter-binding";
import { listMembers } from "@/lib/data/members";

export const SLACK_USER_ID_FORMAT = /^[UW][A-Z0-9]{2,30}$/;

export type RequesterIdentity =
  | {
      identified: true;
      source: "admin_agent_declared_slack_user";
      matchedBy: "verified_voter_binding";
      slackUserId: string;
      memberId: string;
      displayName: string;
    }
  | {
      identified: false;
      source: "admin_agent_declared_slack_user" | "none";
      reason: "not_declared" | "no_active_binding" | "ambiguous_binding" | "member_not_active";
    };

export async function resolveAdminRequester(orgId: string, slackUserId: string | null): Promise<RequesterIdentity> {
  if (!slackUserId) return { identified: false, source: "none", reason: "not_declared" };
  const declared = { source: "admin_agent_declared_slack_user" as const };
  const bindings = (await listVoterBindings({ orgId, provider: "slack" }).catch(() => []))
    .filter((b) => b.orgId === orgId && b.externalUserId === slackUserId && b.status === "active" && b.memberId);
  const memberIds = [...new Set(bindings.map((b) => b.memberId))];
  if (memberIds.length === 0) return { ...declared, identified: false, reason: "no_active_binding" };
  if (memberIds.length > 1) return { ...declared, identified: false, reason: "ambiguous_binding" };
  const member = (await listMembers(orgId).catch(() => [])).find((m) => m.id === memberIds[0] && m.orgId === orgId);
  if (!member || member.status !== "active") return { ...declared, identified: false, reason: "member_not_active" };
  return {
    ...declared,
    identified: true,
    matchedBy: "verified_voter_binding",
    slackUserId,
    memberId: member.id,
    displayName: (member.displayName || member.id).replace(/[\r\n]+/g, " ").slice(0, 60),
  };
}

/** Ticket metadata: requesterMemberId only when identified (read by requesterMemberIdsFromMetadata / SQL). */
export function requesterMetadata(identity: RequesterIdentity): Record<string, unknown> {
  if (identity.identified) {
    return {
      requesterMemberId: identity.memberId,
      requesterIdentity: { identified: true, source: identity.source, matchedBy: identity.matchedBy, memberId: identity.memberId, slackUserId: identity.slackUserId },
    };
  }
  return { requesterIdentity: { identified: false, source: identity.source, reason: identity.reason } };
}

/** One card line. */
export function requesterCardLineJa(identity: RequesterIdentity): string {
  return identity.identified
    ? `■ 依頼者: ${identity.displayName}（AI管理者が伝えた Slack ID を承認者登録で照合）`
    : "■ 依頼者は特定できません（AI管理者経由の申請で、承認者登録と照合できる依頼者の Slack ID がありません）。オーナーが2人以上いても、依頼した本人が承認していないことはシステムでは確認できません。";
}
