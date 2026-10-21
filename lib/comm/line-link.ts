/**
 * L-7: a link code sent to the employee's own LINE (not the approval OA)
 * proves the sender is a Staffpass member. Reuses #354 redeemLineLinkCode
 * (limits forced ON when LINE conversation is ON). channelId = comm account
 * id; the voter binding key is comm_account:<accountId> (WHO at send time).
 * The plaintext code is never stored or logged.
 */
import { upsertProofVerifiedVoterBinding } from "@/lib/approval-workflow/voter-binding";
import { redeemConversationLinkCodeGuarded } from "@/lib/line/link-code-limits";
import { parseLineLinkCodeText } from "@/lib/line/link-code";
import { appendAuditEvent } from "@/lib/data/audit";
import { readCommAccountSecretsForServer } from "@/lib/comm/accounts";
import { LINE_CONVERSATION_LINK_FAIL_JA, LINE_CONVERSATION_LINK_OK_JA } from "@/lib/comm/line-poc-copy";
import { checkLineSendAllowed, type PreSendResult } from "@/lib/comm/pre-send";

/** Short fixed Reply after a successful redeem. Never include the inbound body. */
export const LINE_CONVERSATION_LINKED_REPLY = LINE_CONVERSATION_LINK_OK_JA;

export type LineLinkRedeemDeps = {
  sendReply?: (input: { orgId: string; accountId: string; replyToken: string; text: string }) => Promise<void>;
  checkLineSendAllowed?: (t: {
    orgId: string;
    employeeId: string;
    accountId: string;
    counterpartyId: string;
    requiresLink?: boolean;
  }) => Promise<PreSendResult>;
};

export async function sendConversationLinkReply(
  input: {
    orgId: string;
    accountId: string;
    employeeId: string;
    lineUserId: string;
    replyToken: string | null | undefined;
    text?: string;
  },
  deps: Pick<LineLinkRedeemDeps, "checkLineSendAllowed"> = {}
): Promise<void> {
  const replyToken = String(input.replyToken || "").trim();
  if (!replyToken || !/^[A-Za-z0-9_-]{1,256}$/.test(replyToken)) return;
  const allowed = await (deps.checkLineSendAllowed ?? checkLineSendAllowed)({
    orgId: input.orgId,
    employeeId: input.employeeId,
    accountId: input.accountId,
    counterpartyId: input.lineUserId,
    requiresLink: false,
  }).catch(() => ({ ok: false as const, reason: "hold_state_unavailable" as const }));
  if (!allowed.ok) return;
  const secrets = await readCommAccountSecretsForServer(input.orgId, input.accountId).catch(() => null);
  if (!secrets || !secrets.ok) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secrets.secrets.channelAccessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: input.text || LINE_CONVERSATION_LINKED_REPLY }],
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => undefined);
}

export async function redeemConversationLinkCode(
  input: {
    orgId: string;
    accountId: string;
    employeeId: string;
    text: string;
    lineUserId: string;
    replyToken?: string | null;
  },
  deps: LineLinkRedeemDeps = {}
): Promise<{ handled: false } | { handled: true; bound: boolean; reason?: string }> {
  const code = parseLineLinkCodeText(input.text);
  if (!code) return { handled: false };
  const consumed = await redeemConversationLinkCodeGuarded({
    orgId: input.orgId,
    accountId: input.accountId,
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
    const replyToken = String(input.replyToken || "").trim();
    if (replyToken) {
      const send = deps.sendReply ?? (async ({ replyToken: token, text }) => {
        await sendConversationLinkReply(
          {
            orgId: input.orgId,
            accountId: input.accountId,
            employeeId: input.employeeId,
            lineUserId: input.lineUserId,
            replyToken: token,
            text,
          },
          { checkLineSendAllowed: deps.checkLineSendAllowed }
        );
      });
      await send({
        orgId: input.orgId,
        accountId: input.accountId,
        replyToken,
        text: consumed.replyJa || LINE_CONVERSATION_LINK_FAIL_JA,
      }).catch(() => undefined);
    }
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
  if (bound.ok) {
    const replyToken = String(input.replyToken || "").trim();
    if (replyToken) {
      const send = deps.sendReply ?? (async ({ replyToken: token }) => {
        await sendConversationLinkReply(
          {
            orgId: input.orgId,
            accountId: input.accountId,
            employeeId: input.employeeId,
            lineUserId: input.lineUserId,
            replyToken: token,
          },
          { checkLineSendAllowed: deps.checkLineSendAllowed }
        );
      });
      await send({
        orgId: input.orgId,
        accountId: input.accountId,
        replyToken,
        text: LINE_CONVERSATION_LINKED_REPLY,
      }).catch(() => undefined);
    }
  }
  return { handled: true, bound: bound.ok, reason: bound.ok ? undefined : bound.reason };
}
