/**
 * Extract text from mail attachments for secret scanning.
 *
 * - txt / csv: UTF-8 (invalid sequences become U+FFFD, never thrown)
 * - docx / xlsx / pptx: XML inside the ZIP (tags stripped)
 * - png / jpg: no OCR (gap: image pixels are not scanned; filename is)
 * - pdf: no PDF parser is in package.json. We pull printable runs from the
 *   raw bytes (a `strings`-style fallback) and document the gap: compressed
 *   PDF streams / binary fonts are not fully extracted.
 */
import { readZipEntries } from "@/lib/mail/zip-peek";
import type { MailAttachmentKind } from "@/lib/mail/attachments";

const MAX_EXTRACT_CHARS = 200_000;
const UTF8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

function cap(text: string): string {
  return text.length <= MAX_EXTRACT_CHARS ? text : text.slice(0, MAX_EXTRACT_CHARS);
}

function stripXml(xml: string): string {
  return xml.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function printableRuns(buf: Buffer): string {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    if (run.length >= 6) out.push(run);
    run = "";
  };
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 0x20 && c <= 0x7e) {
      run += String.fromCharCode(c);
      if (run.length >= MAX_EXTRACT_CHARS) break;
    } else {
      flush();
    }
  }
  flush();
  return cap(out.join("\n"));
}

function officeXmlText(buf: Buffer, prefix: string): string {
  const parts: string[] = [];
  for (const entry of readZipEntries(buf)) {
    if (!entry.name.startsWith(prefix) && entry.name !== "[Content_Types].xml") continue;
    if (!entry.name.endsWith(".xml")) continue;
    parts.push(stripXml(UTF8.decode(entry.data)));
    if (parts.join(" ").length >= MAX_EXTRACT_CHARS) break;
  }
  return cap(parts.join(" "));
}

export type MailTextExtract = {
  text: string;
  /** True when a proper parser was not available (PDF) or OCR was skipped. */
  gap?: "pdf_no_parser" | "image_no_ocr";
};

export function extractMailAttachmentText(kind: MailAttachmentKind, buf: Buffer): MailTextExtract {
  if (kind === "txt" || kind === "csv") {
    return { text: cap(UTF8.decode(buf)) };
  }
  if (kind === "docx") return { text: officeXmlText(buf, "word/") };
  if (kind === "xlsx") return { text: officeXmlText(buf, "xl/") };
  if (kind === "pptx") return { text: officeXmlText(buf, "ppt/") };
  if (kind === "png" || kind === "jpg") return { text: "", gap: "image_no_ocr" };
  return { text: printableRuns(buf), gap: "pdf_no_parser" };
}
