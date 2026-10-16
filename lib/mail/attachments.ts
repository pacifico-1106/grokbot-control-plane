/**
 * mail.send attachment validation (fail-closed).
 *
 * Input: filename + Base64 `content` / `contentBase64` only. `fileRef`
 * (HTTPS fetch) is rejected in this PR because of SSRF; Slack's top-level
 * `fileAttachment.fileRef` is unchanged and is not used for mail.send.
 *
 * Limits: 3 files, 10 MiB each, 15 MiB total. Allowlisted MIME + extension
 * with a magic-byte check. Filenames are sanitized (no path / controls).
 */
import { createHash } from "node:crypto";
import { zipHasEntry } from "@/lib/mail/zip-peek";

export const MAIL_ATTACHMENT_MAX_FILES = 3;
export const MAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAIL_ATTACHMENT_MAX_TOTAL_BYTES = 15 * 1024 * 1024;
export const MAIL_ATTACHMENT_MAX_FILENAME_CHARS = 200;
const MAX_BASE64_CHARS = Math.ceil(MAIL_ATTACHMENT_MAX_BYTES * 4 / 3) + 64;

export const MAIL_ATTACHMENT_ERROR_CODES = [
  "mail_attachment_invalid",
  "mail_attachment_count_exceeded",
  "mail_attachment_too_large",
  "mail_attachment_total_too_large",
  "mail_attachment_type_denied",
  "mail_attachment_magic_mismatch",
  "mail_attachment_filename_invalid",
  "mail_attachment_source_required",
  "mail_attachment_source_ambiguous",
  "mail_attachment_source_denied",
  "mail_attachment_content_invalid",
  "mail_attachment_fetch_failed",
  "mail_attachment_storage_unavailable",
  "mail_attachment_hash_mismatch",
  "mail_attachment_unavailable",
] as const;
export type MailAttachmentErrorCode = (typeof MAIL_ATTACHMENT_ERROR_CODES)[number];

export type MailAttachmentKind =
  | "pdf"
  | "png"
  | "jpg"
  | "txt"
  | "csv"
  | "docx"
  | "xlsx"
  | "pptx";

export type MailAttachmentInput = {
  filename: string;
  mimeType?: string;
  bytes?: number;
  /** Base64 file body (required for mail.send; never logged). */
  content?: string;
  contentBase64?: string;
  /**
   * Rejected for mail.send in this PR (SSRF). Accepted later only with
   * dedicated SSRF guards. Slack comm.reply still uses top-level fileRef.
   */
  fileRef?: string;
};

export type ResolvedMailAttachment = {
  filename: string;
  mimeType: string;
  kind: MailAttachmentKind;
  bytes: number;
  contentSha256: string;
  buffer: Buffer;
  source: "content";
};

export type MailAttachmentError = {
  ok: false;
  code: MailAttachmentErrorCode;
  messageJa: string;
};

type KindSpec = {
  kind: MailAttachmentKind;
  mime: string;
  extensions: readonly string[];
};

const KINDS: KindSpec[] = [
  { kind: "pdf", mime: "application/pdf", extensions: ["pdf"] },
  { kind: "png", mime: "image/png", extensions: ["png"] },
  { kind: "jpg", mime: "image/jpeg", extensions: ["jpg", "jpeg"] },
  { kind: "txt", mime: "text/plain", extensions: ["txt"] },
  { kind: "csv", mime: "text/csv", extensions: ["csv"] },
  {
    kind: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
  },
  {
    kind: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
  },
  {
    kind: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: ["pptx"],
  },
];

const MIME_ALIAS: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "text/x-csv": "text/csv",
  "application/csv": "text/csv",
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function fail(code: MailAttachmentErrorCode, messageJa: string): MailAttachmentError {
  return { ok: false, code, messageJa };
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function startsWith(buf: Buffer, magic: Buffer): boolean {
  return buf.length >= magic.length && magic.compare(buf, 0, magic.length) === 0;
}

function extensionOf(filename: string): string {
  const base = filename.split(".").pop() || "";
  return base.toLowerCase();
}

function lookupKind(ext: string, mimeType?: string): KindSpec | null {
  const declared = mimeType ? MIME_ALIAS[mimeType.toLowerCase()] || mimeType.toLowerCase() : undefined;
  const byExt = KINDS.find((k) => k.extensions.includes(ext));
  if (!byExt) return null;
  if (declared && declared !== byExt.mime) return null;
  return byExt;
}

export function sanitizeMailFilename(raw: unknown): { ok: true; filename: string } | MailAttachmentError {
  if (typeof raw !== "string") {
    return fail("mail_attachment_filename_invalid", "添付ファイル名は文字列で指定してください。");
  }
  const trimmed = raw.normalize("NFC").trim();
  if (!trimmed) return fail("mail_attachment_filename_invalid", "添付ファイル名が空です。");
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(trimmed)) {
    return fail("mail_attachment_filename_invalid", "添付ファイル名に制御文字は使えません。");
  }
  if (/[/\\]/.test(trimmed) || trimmed.includes("..")) {
    return fail("mail_attachment_filename_invalid", "添付ファイル名にパスは使えません。");
  }
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(trimmed)) {
    return fail("mail_attachment_filename_invalid", "添付ファイル名に不可視の方向制御文字は使えません。");
  }
  const chars = Array.from(trimmed);
  if (chars.length > MAIL_ATTACHMENT_MAX_FILENAME_CHARS) {
    return fail("mail_attachment_filename_invalid", `添付ファイル名は ${MAIL_ATTACHMENT_MAX_FILENAME_CHARS} 文字以内です。`);
  }
  if (trimmed === "." || trimmed === "..") {
    return fail("mail_attachment_filename_invalid", "添付ファイル名が不正です。");
  }
  return { ok: true, filename: trimmed };
}

function magicMatches(kind: MailAttachmentKind, buf: Buffer): boolean {
  if (kind === "pdf") return buf.length >= 5 && buf.slice(0, 5).toString("latin1") === "%PDF-";
  if (kind === "png") return startsWith(buf, PNG);
  if (kind === "jpg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (kind === "txt" || kind === "csv") {
    if (startsWith(buf, PNG) || startsWith(buf, ZIP) || buf.slice(0, 5).toString("latin1") === "%PDF-") {
      return false;
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return false;
    const sample = buf.subarray(0, Math.min(buf.length, 8192));
    if (sample.includes(0)) return false;
    return true;
  }
  if (!startsWith(buf, ZIP)) return false;
  if (kind === "docx") {
    return zipHasEntry(buf, (n) => n === "[Content_Types].xml" || n.startsWith("word/"));
  }
  if (kind === "xlsx") {
    return zipHasEntry(buf, (n) => n === "[Content_Types].xml" || n.startsWith("xl/"));
  }
  if (kind === "pptx") {
    return zipHasEntry(buf, (n) => n === "[Content_Types].xml" || n.startsWith("ppt/"));
  }
  return false;
}

function decodeBase64(raw: string): { ok: true; buffer: Buffer } | MailAttachmentError {
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return fail("mail_attachment_content_invalid", "添付の content が空です。");
  if (compact.length > MAX_BASE64_CHARS) {
    return fail("mail_attachment_too_large", `添付は 1 ファイルあたり最大 ${MAIL_ATTACHMENT_MAX_BYTES} バイトです。`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return fail("mail_attachment_content_invalid", "添付の content は Base64 で指定してください。");
  }
  const estimated = Math.floor(compact.length * 3 / 4);
  if (estimated > MAIL_ATTACHMENT_MAX_BYTES) {
    return fail("mail_attachment_too_large", `添付は 1 ファイルあたり最大 ${MAIL_ATTACHMENT_MAX_BYTES} バイトです。`);
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(compact, "base64");
  } catch {
    return fail("mail_attachment_content_invalid", "添付の content をデコードできませんでした。");
  }
  if (buffer.length === 0) return fail("mail_attachment_content_invalid", "添付の content が空です。");
  return { ok: true, buffer };
}

async function loadBytes(input: MailAttachmentInput): Promise<
  { ok: true; buffer: Buffer; source: "content" } | MailAttachmentError
> {
  const content =
    typeof input.content === "string" ? input.content :
    typeof input.contentBase64 === "string" ? input.contentBase64 :
    undefined;
  const fileRef = typeof input.fileRef === "string" ? input.fileRef.trim() : "";
  const hasContent = typeof content === "string" && content.trim().length > 0;
  // SSRF: never fetch. fileRef is refused even when content is also present.
  if (fileRef) {
    return fail(
      "mail_attachment_source_denied",
      "mail.send の添付は Base64 の content のみです。fileRef（URL 取得）は受け付けません。"
    );
  }
  if (!hasContent) {
    return fail("mail_attachment_source_required", "添付には Base64 の content が必要です。");
  }
  const decoded = decodeBase64(content!);
  if (!decoded.ok) return decoded;
  return { ok: true, buffer: decoded.buffer, source: "content" };
}

function parseOneInput(raw: unknown, index: number): { ok: true; input: MailAttachmentInput } | MailAttachmentError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("mail_attachment_invalid", `attachments[${index}] はオブジェクトで指定してください。`);
  }
  const rec = raw as Record<string, unknown>;
  const filename = rec.filename;
  const input: MailAttachmentInput = { filename: typeof filename === "string" ? filename : "" };
  if (typeof rec.fileRef === "string") input.fileRef = rec.fileRef;
  if (typeof rec.mimeType === "string") input.mimeType = rec.mimeType.trim();
  if (typeof rec.bytes === "number") input.bytes = rec.bytes;
  if (typeof rec.content === "string") input.content = rec.content;
  if (typeof rec.contentBase64 === "string") input.contentBase64 = rec.contentBase64;
  return { ok: true, input };
}

export function collectMailAttachmentInputs(args: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(args, "attachments")) return undefined;
  return args.attachments;
}

export async function resolveMailAttachments(
  raw: unknown
): Promise<{ ok: true; attachments: ResolvedMailAttachment[] } | MailAttachmentError> {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) {
    return fail("mail_attachment_invalid", "attachments は配列で指定してください。");
  }
  const parsedItems: MailAttachmentInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseOneInput(raw[i], i);
    if (!parsed.ok) return parsed;
    parsedItems.push(parsed.input);
  }
  const hasSource = (input: MailAttachmentInput) => {
    const content =
      typeof input.content === "string" ? input.content.trim() :
      typeof input.contentBase64 === "string" ? input.contentBase64.trim() :
      "";
    const fileRef = typeof input.fileRef === "string" ? input.fileRef.trim() : "";
    return Boolean(content || fileRef);
  };
  // Legacy mail policy flag: `attachments: [{ name, size }]` means "has
  // attachments" without bytes. Only objects that carry content (or a
  // rejected fileRef, which must fail closed rather than look like a flag)
  // are loaded. Mixing flag-only rows with real files is refused.
  if (!parsedItems.some(hasSource)) {
    return { ok: true, attachments: [] };
  }
  if (raw.length > MAIL_ATTACHMENT_MAX_FILES) {
    return fail("mail_attachment_count_exceeded", `添付は最大 ${MAIL_ATTACHMENT_MAX_FILES} 件です。`);
  }

  const attachments: ResolvedMailAttachment[] = [];
  let total = 0;
  for (let i = 0; i < parsedItems.length; i++) {
    const parsed = { ok: true as const, input: parsedItems[i]! };
    const named = sanitizeMailFilename(parsed.input.filename);
    if (!named.ok) return named;
    const ext = extensionOf(named.filename);
    const spec = lookupKind(ext, parsed.input.mimeType);
    if (!spec) {
      return fail(
        "mail_attachment_type_denied",
        "添付の種類が許可されていません（pdf / png / jpg / txt / csv / docx / xlsx / pptx）。"
      );
    }
    const loaded = await loadBytes(parsed.input);
    if (!loaded.ok) return loaded;
    if (loaded.buffer.length > MAIL_ATTACHMENT_MAX_BYTES) {
      return fail("mail_attachment_too_large", `添付は 1 ファイルあたり最大 ${MAIL_ATTACHMENT_MAX_BYTES} バイトです。`);
    }
    if (typeof parsed.input.bytes === "number" && Number.isFinite(parsed.input.bytes) && parsed.input.bytes !== loaded.buffer.length) {
      return fail("mail_attachment_invalid", "添付の bytes が実サイズと一致しません。");
    }
    total += loaded.buffer.length;
    if (total > MAIL_ATTACHMENT_MAX_TOTAL_BYTES) {
      return fail("mail_attachment_total_too_large", `添付の合計は最大 ${MAIL_ATTACHMENT_MAX_TOTAL_BYTES} バイトです。`);
    }
    if (!magicMatches(spec.kind, loaded.buffer)) {
      return fail("mail_attachment_magic_mismatch", "添付の内容が拡張子・MIME と一致しません。");
    }
    attachments.push({
      filename: named.filename,
      mimeType: spec.mime,
      kind: spec.kind,
      bytes: loaded.buffer.length,
      contentSha256: sha256hex(loaded.buffer),
      buffer: loaded.buffer,
      source: loaded.source,
    });
  }
  return { ok: true, attachments };
}
