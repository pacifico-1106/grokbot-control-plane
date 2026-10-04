/** STUB (TDD red phase). */
import type { GatewayInvokeRequest } from "@/lib/types";
import type { InvokeSnapshot } from "@/lib/approvals/fulfill";

export type ConversationKeyInput = {
  orgId: string;
  surface?: string;
  slackChannelId?: string;
  slackUserId?: string;
  threadId?: string;
  lineId?: string;
  telegramChatId?: string;
  telegramThreadId?: string;
  email?: string;
  phone?: string;
};

export function conversationKeyInputFromBody(
  _body: GatewayInvokeRequest,
  _orgId: string
): ConversationKeyInput | null {
  return null;
}

export function conversationKeyInputFromSnapshot(
  _snapshot: InvokeSnapshot,
  _orgId: string
): ConversationKeyInput | null {
  return null;
}

export function conversationKey(_input: ConversationKeyInput, _key: Buffer): string | null {
  return null;
}
