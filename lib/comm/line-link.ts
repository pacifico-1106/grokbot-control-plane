/**
 * L-7: a link code sent to the employee's own LINE (not the approval OA)
 * proves the sender is a Staffpass member. Reuses #354 redeemLineLinkCode
 * (limits forced ON when LINE conversation is ON). channelId = comm account
 * id; the voter binding key is comm_account:<accountId> (WHO at send time).
 * The plaintext code is never stored or logged.
 */
import { upsertProofVerifiedVoterBinding } from "@/lib/approval-workflow/voter-binding";
import { redeemLineLinkCode } from "@/lib/line/link-code-limits";
import { parseLineLinkCodeText } from "@/lib/line/link-code";
import { appendAuditEvent } from "@/lib/data/audit";

export async function redeemConversationLinkCode(input: {
  orgId: string;
  accountId: string;
  text: string;
  lineUserId: string;
}): Promise<{ handled: false } | { handled: true; bound: boolean; reason?: string }> {
  const code = parseLineLinkCodeText(input.text);
  if (!code) return { handled: false };
  const consumed = await redeemLineLinkCode({
    orgId: input.orgId,
    channelId: input.accountId,
    code,
    lineUserId: input.lineUserId,
  });
  if (!consumed.ok) {
    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: null,
      credentialId: null,
      action: "notification.channel_updated",
      purpose: null,
      summary: "LINE 会話の連携コードを受け取れませんでした",
      metadata: {
        event: "line_conversation_link_failed",
        accountId: input.accountId,
        reason: consumed.reason,
      },
    }).catch(() => undefined);
    return { handled: true, bound: false, reason: consumed.reason };
  }
  const bound = await upsertProofVerifiedVoterBinding({
    orgId: input.orgId,
    provider: "line",
    channelKey: `comm_account:${input.accountId}`,
    externalUserId: input.lineUserId,
    memberId: consumed.memberId,
  });
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: null,
    credentialId: null,
    action: "notification.channel_updated",
    purpose: null,
    summary: bound.ok ? "LINE 会話の連携コードで社内に紐付けた" : "LINE 会話の連携コードの紐付けに失敗",
    metadata: {
      event: bound.ok ? "line_conversation_linked" : "line_conversation_link_failed",
      accountId: input.accountId,
      memberId: consumed.memberId,
      ...(bound.ok ? {} : { reason: bound.reason }),
    },
  }).catch(() => undefined);
  return { handled: true, bound: bound.ok, reason: bound.ok ? undefined : bound.reason };
}
