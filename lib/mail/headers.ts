/**
 * mail.send reply-threading headers.
 *
 * Optional In-Reply-To / References (RFC 5322 Message-ID) and/or a Gmail
 * threadId. Values are fail-closed: CR/LF and other controls are refused
 * (header injection), not rewritten. When the outbound provider is Gmail the
 * same validated values are applied as In-Reply-To / References headers and
 * as the Gmail API `threadId`.
 */
export const MAIL_HEADER_INVALID = "mail_header_invalid" as const;

export type MailThreading = {
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
};

export type MailHeaderError = {
  ok: false;
  code: typeof MAIL_HEADER_INVALID;
  field: string;
  messageJa: string;
};

const MAX_ID_CHARS = 200;
const MAX_REFERENCE_IDS = 20;
/** Gmail thread ids are hex; the product example is 16 chars. */
const GMAIL_THREAD_ID = /^[0-9a-f]{6,32}$/i;
/**
 * RFC 5322 msg-id without CFWS: local@id-right, optional <>.
 * No whitespace, quotes, backslash, or control characters.
 */
const MSG_ID = /^<?[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+>?$/;

function hasForbiddenChars(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

function normalizeMsgId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_ID_CHARS) return null;
  if (hasForbiddenChars(trimmed) || /\s/.test(trimmed)) return null;
  if (!MSG_ID.test(trimmed)) return null;
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

function parseIdList(value: unknown, field: string): { ok: true; ids: string[] } | MailHeaderError {
  if (value === undefined || value === null || value === "") return { ok: true, ids: [] };
  const parts: string[] = [];
  if (typeof value === "string") {
    if (hasForbiddenChars(value)) {
      return {
        ok: false,
        code: MAIL_HEADER_INVALID,
        field,
        messageJa: `${field} に改行や制御文字は使えません。`,
      };
    }
    parts.push(...value.trim().split(/\s+/).filter(Boolean));
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        return {
          ok: false,
          code: MAIL_HEADER_INVALID,
          field,
          messageJa: `${field} は Message-ID の文字列（またはその配列）で指定してください。`,
        };
      }
      if (hasForbiddenChars(item)) {
        return {
          ok: false,
          code: MAIL_HEADER_INVALID,
          field,
          messageJa: `${field} に改行や制御文字は使えません。`,
        };
      }
      const piece = item.trim();
      if (piece) parts.push(...piece.split(/\s+/).filter(Boolean));
    }
  } else {
    return {
      ok: false,
      code: MAIL_HEADER_INVALID,
      field,
      messageJa: `${field} は Message-ID の文字列（またはその配列）で指定してください。`,
    };
  }
  if (parts.length > MAX_REFERENCE_IDS) {
    return {
      ok: false,
      code: MAIL_HEADER_INVALID,
      field,
      messageJa: `${field} は最大 ${MAX_REFERENCE_IDS} 件までです。`,
    };
  }
  const ids: string[] = [];
  for (const part of parts) {
    const id = normalizeMsgId(part);
    if (!id) {
      return {
        ok: false,
        code: MAIL_HEADER_INVALID,
        field,
        messageJa: `${field} の Message-ID 形式が不正です。`,
      };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

function parseThreadId(value: unknown, field: string): { ok: true; threadId?: string } | MailHeaderError {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value !== "string") {
    return {
      ok: false,
      code: MAIL_HEADER_INVALID,
      field,
      messageJa: `${field} は Gmail の threadId（16 進）で指定してください。`,
    };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (hasForbiddenChars(trimmed) || /\s/.test(trimmed) || !GMAIL_THREAD_ID.test(trimmed)) {
    return {
      ok: false,
      code: MAIL_HEADER_INVALID,
      field,
      messageJa: `${field} の形式が不正です（改行不可、Gmail threadId は 16 進のみ）。`,
    };
  }
  return { ok: true, threadId: trimmed.toLowerCase() };
}

/**
 * Read optional threading fields from mail.send args (and conversation.threadId
 * when the surface is mail). Fail-closed on injection / malformed values.
 */
export function parseMailThreading(args: Record<string, unknown>, conversation?: {
  surface?: string;
  threadId?: string;
} | null): { ok: true; threading: MailThreading } | MailHeaderError {
  const inReplyToRaw = args.inReplyTo ?? args.in_reply_to;
  const inReplyToParsed = parseIdList(inReplyToRaw, "inReplyTo");
  if (!inReplyToParsed.ok) return inReplyToParsed;
  if (inReplyToParsed.ids.length > 1) {
    return {
      ok: false,
      code: MAIL_HEADER_INVALID,
      field: "inReplyTo",
      messageJa: "inReplyTo は Message-ID を 1 件だけ指定してください。",
    };
  }

  const referencesParsed = parseIdList(args.references, "references");
  if (!referencesParsed.ok) return referencesParsed;

  const threadFromArgs = parseThreadId(args.gmailThreadId ?? args.threadId, "threadId");
  if (!threadFromArgs.ok) return threadFromArgs;
  const surface = (conversation?.surface || "").toLowerCase();
  let conversationThreadId: string | undefined;
  if (surface === "mail" || surface === "gmail") {
    const threadFromConv = parseThreadId(conversation?.threadId, "conversation.threadId");
    if (!threadFromConv.ok) return threadFromConv;
    conversationThreadId = threadFromConv.threadId;
  }

  const threading: MailThreading = {};
  if (inReplyToParsed.ids[0]) threading.inReplyTo = inReplyToParsed.ids[0];
  if (referencesParsed.ids.length) {
    const refs = [...referencesParsed.ids];
    if (threading.inReplyTo && !refs.includes(threading.inReplyTo)) refs.push(threading.inReplyTo);
    threading.references = refs;
  } else if (threading.inReplyTo) {
    threading.references = [threading.inReplyTo];
  }
  const threadId = threadFromArgs.threadId || conversationThreadId;
  if (threadId) threading.threadId = threadId;
  return { ok: true, threading };
}

export function mailProviderIsGmail(args: Record<string, unknown>, conversation?: {
  surface?: string;
} | null): boolean {
  const provider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  if (provider === "gmail") return true;
  const surface = (conversation?.surface || "").toLowerCase();
  return surface === "gmail" || surface === "mail";
}

/**
 * Fail-closed envelope headers (From / To / Subject / Cc / Bcc).
 * CR/LF and other controls are refused, not rewritten — same rule as
 * In-Reply-To / References. Used at invoke and at the RFC822 builder.
 */
export function assertMailEnvelopeValue(
  field: string,
  value: unknown
): { ok: true; value: string } | MailHeaderError {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: "" };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      code: MAIL_HEADER_INVALID,
      field,
      messageJa: `${field} は文字列で指定してください。`,
    };
  }
  if (hasForbiddenChars(value) || /[\r\n]/.test(value)) {
    return {
      ok: false,
      code: MAIL_HEADER_INVALID,
      field,
      messageJa: `${field} に改行や制御文字は使えません。`,
    };
  }
  return { ok: true, value: value.trim() };
}

function assertEnvelopeList(field: string, value: unknown): { ok: true } | MailHeaderError {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (Array.isArray(value)) {
    for (const item of value) {
      // Type errors stay with the existing mail_recipient_invalid path.
      if (typeof item !== "string") continue;
      const checked = assertMailEnvelopeValue(field, item);
      if (!checked.ok) return checked;
    }
    return { ok: true };
  }
  if (typeof value !== "string") return { ok: true };
  return assertMailEnvelopeValue(field, value);
}

/** Validate From / To / Subject / Cc / Bcc before approval or send. */
export function parseMailEnvelope(args: Record<string, unknown>): { ok: true } | MailHeaderError {
  for (const [field, raw] of [
    ["from", args.from ?? args.sender],
    ["to", args.to ?? args.recipient ?? args.email],
    ["subject", args.subject ?? args.title],
  ] as const) {
    // Non-strings keep the existing mail_recipient_invalid / missing-field codes.
    if (typeof raw !== "string") continue;
    const checked = assertMailEnvelopeValue(field, raw);
    if (!checked.ok) return checked;
  }
  const cc = assertEnvelopeList("cc", args.cc);
  if (!cc.ok) return cc;
  const bcc = assertEnvelopeList("bcc", args.bcc);
  if (!bcc.ok) return bcc;
  return { ok: true };
}
