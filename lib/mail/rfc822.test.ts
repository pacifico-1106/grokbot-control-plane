import { describe, expect, test } from "bun:test";
import { buildRfc822Message, gmailRawBase64Url } from "./rfc822";
import { minimalPdf } from "./test-pdf";

describe("buildRfc822Message", () => {
  test("builds multipart with RFC 2231 filename and In-Reply-To", () => {
    const pdf = minimalPdf("overview");
    const rfc = buildRfc822Message({
      from: "tando@tokyo307inc.com",
      to: "info@s-value.co.jp",
      subject: "Staffpass サービス概要",
      body: "PDF を添付します。",
      inReplyTo: "<CA+thread@mail.gmail.com>",
      references: "<CA+thread@mail.gmail.com>",
      attachments: [
        { filename: "Staffpass_サービス概要.pdf", mimeType: "application/pdf", buffer: pdf },
      ],
    });
    expect(rfc).toContain("From: tando@tokyo307inc.com");
    expect(rfc).toContain("To: info@s-value.co.jp");
    expect(rfc).toContain("In-Reply-To: <CA+thread@mail.gmail.com>");
    expect(rfc).toContain("filename*=UTF-8''");
    expect(rfc).toContain("Content-Type: application/pdf");
    expect(rfc).not.toMatch(/\r\nBcc:/);
    expect(gmailRawBase64Url(rfc)).not.toMatch(/[+/=]/);
  });

  test("rejects CR/LF in From", () => {
    expect(() =>
      buildRfc822Message({
        from: "tando@tokyo307inc.com\r\nBcc: evil@x.example",
        to: "info@s-value.co.jp",
        subject: "s",
        body: "b",
      })
    ).toThrow("mail_header_invalid:from");
  });
});
