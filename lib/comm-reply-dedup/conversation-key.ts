/**
 * Channel-independent conversation key for duplicate-reply prevention:
 *   surface + destination (+ thread for group conversations).
 * 1:1 destinations (Slack DM `D…`, LINE user `U…`, Telegram private chat,
 * phone) ignore the thread: the same person sees both. The key is a keyed
 * HMAC (org-scoped) so raw channel / user ids never appear in the ledger.
 *
 * Telegram has no gateway conversation surface yet; its fields are read from
 * the raw request (conversation / args) so the key already exists for it.
 */
import { createHmac } from "node:crypto";
import { parseConversationContext } from "@/lib/gateway/audience";
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
  /** sns.publish: the employee's own account on that medium is the "conversation". */
  snsSurface?: string;
  snsEmployeeId?: string;
};

const str = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function telegramFields(conv: Record<string, unknown>, args: Record<string, unknown>) {
  return {
    telegramChatId: str(conv.telegramChatId) || str(conv.chatId) || str(args.telegramChatId) || str(args.chatId),
    telegramThreadId:
      str(conv.telegramThreadId) || str(conv.messageThreadId) || str(args.telegramThreadId) || str(args.messageThreadId),
  };
}

function rawSurface(body: { surface?: unknown; conversation?: unknown; args?: unknown }): string | undefined {
  const conv = rec(body.conversation);
  const args = rec(body.args);
  return (str(conv.surface) || str(body.surface) || str(args.surface) || str(args.channelSurface))?.toLowerCase();
}

export function conversationKeyInputFromBody(body: GatewayInvokeRequest, orgId: string): ConversationKeyInput | null {
  const conv = rec(body.conversation);
  const args = rec(body.args);
  const surface = rawSurface(body as unknown as Record<string, unknown>);
  if (surface === "telegram") {
    return { orgId, surface, ...telegramFields(conv, args) };
  }
  const ctx = parseConversationContext(body, orgId);
  if (!ctx) return null;
  return {
    orgId,
    surface: ctx.surface,
    slackChannelId: ctx.slackChannelId,
    slackUserId: ctx.slackUserId,
    threadId: ctx.threadId,
    lineId: ctx.lineId,
    email: ctx.email,
    phone: ctx.phone,
  };
}

export function conversationKeyInputFromSnapshot(snapshot: InvokeSnapshot, orgId: string): ConversationKeyInput | null {
  const conv = snapshot.conversation;
  const args = rec(snapshot.args);
  const surface = (conv?.surface || str(args.surface))?.toLowerCase();
  if (surface === "telegram") return { orgId, surface, ...telegramFields(rec(conv), args) };
  if (!conv || !surface) return null;
  return {
    orgId,
    surface,
    slackChannelId: conv.slackChannelId,
    slackUserId: conv.slackUserId,
    threadId: conv.threadId,
    lineId: conv.lineId,
    email: conv.email,
    phone: conv.phone,
  };
}

/** [destination kind, destination id, is 1:1] — null when there is no destination. */
function destinationOf(input: ConversationKeyInput): [string, string, boolean] | null {
  switch (input.surface) {
    case "slack": {
      const channel = str(input.slackChannelId);
      if (channel) return ["channel", channel, /^D[A-Z0-9]+$/.test(channel)];
      const user = str(input.slackUserId);
      return user ? ["user", user, true] : null;
    }
    case "line": {
      const id = str(input.lineId);
      return id ? ["line", id, /^U/.test(id)] : null;
    }
    case "telegram": {
      const id = str(input.telegramChatId);
      return id ? ["chat", id, /^\d+$/.test(id)] : null;
    }
    case "mail": {
      const email = str(input.email)?.toLowerCase();
      return email ? ["mail", email, false] : null;
    }
    case "phone": {
      const phone = str(input.phone)?.replace(/[^\d+]/g, "");
      return phone ? ["phone", phone, true] : null;
    }
    case "sns": {
      const media = str(input.snsSurface)?.toLowerCase();
      const employee = str(input.snsEmployeeId);
      // One timeline per employee account: never shared with another employee.
      return media && employee ? ["sns", `${media}:${employee}`, true] : null;
    }
    default: {
      const any = str(input.slackChannelId) || str(input.lineId) || str(input.email) || str(input.phone);
      return any ? ["other", any, false] : null;
    }
  }
}

export function conversationKey(input: ConversationKeyInput, key: Buffer): string | null {
  const dest = destinationOf(input);
  if (!dest || !input.orgId) return null;
  const [kind, id, oneToOne] = dest;
  const thread = oneToOne ? "" : str(input.surface === "telegram" ? input.telegramThreadId : input.threadId) ?? "";
  return createHmac("sha256", key)
    .update(["conv", "v1", input.orgId, input.surface ?? "", kind, id, thread].join("\u0000"))
    .digest("hex");
}

/**
 * Channel-level key (duplicate post guard v2): the destination without the
 * thread, so a top-level post and a thread post in the same channel compare.
 * For 1:1 destinations it names the same place as conversationKey.
 * Separate HMAC domain ("chan"), so it never equals a conversation key.
 */
export function channelKey(input: ConversationKeyInput, key: Buffer): string | null {
  const dest = destinationOf(input);
  if (!dest || !input.orgId) return null;
  const [kind, id] = dest;
  return createHmac("sha256", key)
    .update(["chan", "v1", input.orgId, input.surface ?? "", kind, id].join("\u0000"))
    .digest("hex");
}

/** sns.publish: surface "sns", medium + employee (accounts are per employee). */
export function snsConversationKeyInput(orgId: string, employeeId: string, media: unknown): ConversationKeyInput | null {
  const m = str(media);
  if (!m || !employeeId) return null;
  return { orgId, surface: "sns", snsSurface: m.toLowerCase() === "twitter" ? "x" : m.toLowerCase(), snsEmployeeId: employeeId };
}
