/**
 * RFC 2231 / 5987 Content-Disposition filename encoding for mail.send.
 * Used when the provider is Gmail (and any MIME builder). ASCII fallback
 * `filename=` plus `filename*=UTF-8''…`.
 */
import type { MailThreading } from "@/lib/mail/headers";
import type { ResolvedMailAttachment } from "@/lib/mail/attachments";

const ATTR_SAFE = /[A-Za-z0-9!#$+\-.^_`|~]/;

export function rfc2231FilenameParam(filename: string): string {
  const encoded = Array.from(Buffer.from(filename, "utf8"))
    .map((b) => {
      const ch = String.fromCharCode(b);
      return ATTR_SAFE.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 150) || "attachment";
  return `filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function contentDispositionAttachment(filename: string): string {
  return `attachment; ${rfc2231FilenameParam(filename)}`;
}

export type GmailOutboundHeaders = {
  inReplyTo?: string;
  references?: string;
  threadId?: string;
};

/** Headers + Gmail threadId to apply when the provider is Gmail. */
export function gmailReplyHeaders(threading: MailThreading): GmailOutboundHeaders {
  const headers: GmailOutboundHeaders = {};
  if (threading.inReplyTo) headers.inReplyTo = threading.inReplyTo;
  if (threading.references?.length) headers.references = threading.references.join(" ");
  if (threading.threadId) headers.threadId = threading.threadId;
  return headers;
}

export type MailMimePart = {
  filename: string;
  mimeType: string;
  bytes: number;
  contentSha256: string;
  contentDisposition: string;
};

export function mailAttachmentMimeParts(
  attachments: Array<Pick<ResolvedMailAttachment, "filename" | "mimeType" | "bytes" | "contentSha256">>
): MailMimePart[] {
  return attachments.map((att) => ({
    filename: att.filename,
    mimeType: att.mimeType,
    bytes: att.bytes,
    contentSha256: att.contentSha256,
    contentDisposition: contentDispositionAttachment(att.filename),
  }));
}
