import { describe, expect, test } from "bun:test";
import {
  MAIL_ATTACHMENT_MAX_FILES,
  resolveMailAttachments,
  sanitizeMailFilename,
} from "./attachments";
import { rfc2231FilenameParam } from "./mime";
import { omitMailAttachmentBinary } from "./omit-binary";
import { extractMailAttachmentText } from "./text-extract";
import { scanMailAttachmentsForSecrets } from "./secret-scan";
import { detectSecretInPayload } from "@/lib/security/secret-detector";
import { minimalPdf } from "./test-pdf";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("IHDR"),
]);

describe("sanitizeMailFilename", () => {
  test("keeps a non-ASCII name", () => {
    const r = sanitizeMailFilename("Staffpass_サービス概要.pdf");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filename).toBe("Staffpass_サービス概要.pdf");
  });

  test("rejects path, separators and control characters", () => {
    for (const name of ["../secret.pdf", "a/b.pdf", "a\\b.pdf", "x.pdf\n.txt", "x\u0000.pdf"]) {
      const r = sanitizeMailFilename(name);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("mail_attachment_filename_invalid");
    }
  });
});

describe("rfc2231FilenameParam", () => {
  test("encodes the Japanese service-overview name", () => {
    const param = rfc2231FilenameParam("Staffpass_サービス概要.pdf");
    expect(param).toContain('filename="Staffpass_');
    expect(param).toContain("filename*=UTF-8''Staffpass_");
    expect(param).toContain("%E3%82%B5%E3%83%BC%E3%83%93%E3%82%B9");
    expect(param).not.toMatch(/[\r\n]/);
  });
});

describe("resolveMailAttachments", () => {
  test("accepts a Base64 PDF", async () => {
    const pdf = minimalPdf();
    const r = await resolveMailAttachments([
      {
        filename: "Staffpass_サービス概要.pdf",
        mimeType: "application/pdf",
        content: pdf.toString("base64"),
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachments[0]?.kind).toBe("pdf");
    expect(r.attachments[0]?.filename).toBe("Staffpass_サービス概要.pdf");
    expect(r.attachments[0]?.bytes).toBe(pdf.length);
    expect(r.attachments[0]?.contentSha256).toHaveLength(64);
  });

  test("rejects a fourth file", async () => {
    const pdf = minimalPdf().toString("base64");
    const files = Array.from({ length: MAIL_ATTACHMENT_MAX_FILES + 1 }, (_, i) => ({
      filename: `n${i}.pdf`,
      content: pdf,
    }));
    const r = await resolveMailAttachments(files);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mail_attachment_count_exceeded");
  });

  test("rejects exe disguised as pdf", async () => {
    const r = await resolveMailAttachments([
      { filename: "x.pdf", mimeType: "application/pdf", content: Buffer.from("MZ").toString("base64") },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mail_attachment_magic_mismatch");
  });

  test("rejects fileRef even with content (no HTTPS fetch / SSRF)", async () => {
    const r = await resolveMailAttachments([
      {
        filename: "x.pdf",
        content: minimalPdf().toString("base64"),
        fileRef: "https://127.0.0.1/x.pdf",
      },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mail_attachment_source_denied");
  });

  test("rejects fileRef-only including loopback HTTPS (no fetch)", async () => {
    const r = await resolveMailAttachments([
      { filename: "x.pdf", fileRef: "https://127.0.0.1/etc/passwd" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mail_attachment_source_denied");
  });

  test("rejects a local file path as fileRef", async () => {
    const r = await resolveMailAttachments([
      { filename: "x.pdf", fileRef: "/etc/passwd" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mail_attachment_source_denied");
  });

  test("rejects a type outside the allowlist", async () => {
    const r = await resolveMailAttachments([
      { filename: "x.exe", content: Buffer.from("MZ").toString("base64") },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mail_attachment_type_denied");
  });

  test("accepts png magic", async () => {
    const r = await resolveMailAttachments([
      { filename: "a.png", content: PNG.toString("base64") },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attachments[0]?.kind).toBe("png");
  });
});

describe("omitMailAttachmentBinary", () => {
  test("drops Base64 so the generic detector does not see a 690KB payload", () => {
    const content = "A".repeat(50_000);
    const body = {
      tool: "mail.send",
      args: {
        to: "info@s-value.co.jp",
        attachments: [{ filename: "Staffpass_サービス概要.pdf", content }],
      },
    };
    const omitted = omitMailAttachmentBinary(body) as {
      args: { attachments: Array<{ content: string; filename: string }> };
    };
    expect(omitted.args.attachments[0]?.content).toBe("[omitted:attachment_bytes]");
    expect(omitted.args.attachments[0]?.filename).toBe("Staffpass_サービス概要.pdf");
    const scan = detectSecretInPayload(omitted);
    expect(scan.ok).toBe(true);
  });

  test("does not omit args.content (mail body alias)", () => {
    const omitted = omitMailAttachmentBinary({
      args: { content: "sk-this-is-not-scanned-here-wait-it-is" },
    }) as { args: { content: string } };
    expect(omitted.args.content).toContain("sk-");
  });
});

describe("attachment secret scan", () => {
  test("flags a staffpass employee secret in a txt file", () => {
    const buf = Buffer.from("token gb_emp_0123456789abcdef_0123456789abcdef0123456789abcdef\n");
    const r = scanMailAttachmentsForSecrets([
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        kind: "txt",
        bytes: buf.length,
        contentSha256: "a".repeat(64),
        buffer: buf,
        source: "content",
      },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.pattern).toBe("staffpass_employee");
  });

  test("pdf extraction is a documented strings fallback", () => {
    const extracted = extractMailAttachmentText("pdf", minimalPdf("visible-pdf-text-block"));
    expect(extracted.gap).toBe("pdf_no_parser");
    expect(extracted.text).toContain("visible-pdf-text-block");
  });
});
