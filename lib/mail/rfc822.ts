/**
 * RFC 2822 / MIME builder for Gmail users.messages.send `raw`.
 * Header values are fail-closed on CR/LF. Bodies are never logged.
 */
import { randomBytes } from "node:crypto";
import { contentDispositionAttachment } from "@/lib/mail/mime";

export type Rfc822Attachment = {
  filename: string;
  mimeType: string;
  buffer: Buffer;
};

export type Rfc822Mail = {
  from: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Rfc822Attachment[];
};

function hasCtl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function oneHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function rfc2047Encode(value: string): string {
  const folded = oneHeader(value);
  if (!folded) return "";
  if (/^[\x20-\x7e]*$/.test(folded)) return folded;
  return `=?UTF-8?B?${Buffer.from(folded, "utf8").toString("base64")}?=`;
}

function assertHeader(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || hasCtl(trimmed) || /[\r\n]/.test(value)) {
    throw new Error(`mail_header_invalid:${field}`);
  }
  return oneHeader(trimmed);
}

function addresses(values: string[] | undefined): string | undefined {
  if (!values?.length) return undefined;
  const cleaned = values.map((v) => assertHeader("address", v));
  return cleaned.join(", ");
}

export function buildRfc822Message(mail: Rfc822Mail): string {
  const from = assertHeader("from", mail.from);
  const to = assertHeader("to", mail.to);
  const subject = rfc2047Encode(mail.subject || "");
  const cc = addresses(mail.cc);
  const bcc = addresses(mail.bcc);
  const inReplyTo = mail.inReplyTo ? assertHeader("inReplyTo", mail.inReplyTo) : "";
  const references = mail.references ? assertHeader("references", mail.references) : "";
  const attachments = mail.attachments ?? [];
  const boundary = `sp${randomBytes(12).toString("hex")}`;
  const headers: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject || "(no subject)"}`,
    "MIME-Version: 1.0",
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const textPart = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.body || "", "utf8").toString("base64"),
  ].join("\r\n");

  if (attachments.length === 0) {
    return `${headers.join("\r\n")}\r\n${textPart}\r\n`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const chunks = [`${headers.join("\r\n")}\r\n\r\n`, `--${boundary}\r\n${textPart}\r\n`];
  for (const att of attachments) {
    const mime = assertHeader("mimeType", att.mimeType || "application/octet-stream");
    const disposition = contentDispositionAttachment(att.filename);
    if (/[\r\n]/.test(disposition)) throw new Error("mail_header_invalid:filename");
    chunks.push(
      `--${boundary}\r\n` +
        `Content-Type: ${mime}\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        `Content-Disposition: ${disposition}\r\n` +
        `\r\n` +
        att.buffer.toString("base64") +
        `\r\n`
    );
  }
  chunks.push(`--${boundary}--\r\n`);
  return chunks.join("");
}

export function gmailRawBase64Url(rfc822: string): string {
  return Buffer.from(rfc822, "utf8").toString("base64url");
}
