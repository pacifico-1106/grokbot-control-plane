import { describe, expect, test } from "bun:test";
import { mailProviderIsGmail, parseMailEnvelope, parseMailThreading } from "./headers";

describe("parseMailThreading", () => {
  test("accepts a Gmail threadId and Message-ID", () => {
    const r = parseMailThreading({
      inReplyTo: "<CA+abc@mail.gmail.com>",
      references: "<CA+abc@mail.gmail.com>",
      gmailThreadId: "1a13940ce0564833",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.threading.inReplyTo).toBe("<CA+abc@mail.gmail.com>");
    expect(r.threading.references).toEqual(["<CA+abc@mail.gmail.com>"]);
    expect(r.threading.threadId).toBe("1a13940ce0564833");
  });

  test("wraps a bare Message-ID in angle brackets", () => {
    const r = parseMailThreading({ inReplyTo: "abc.def@mail.gmail.com" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.threading.inReplyTo).toBe("<abc.def@mail.gmail.com>");
    expect(r.threading.references).toEqual(["<abc.def@mail.gmail.com>"]);
  });

  test("rejects CRLF in inReplyTo", () => {
    const r = parseMailThreading({ inReplyTo: "<ok@x.example>\r\nBcc: evil@x.example>" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("mail_header_invalid");
    expect(r.field).toBe("inReplyTo");
  });

  test("rejects CRLF in references", () => {
    const r = parseMailThreading({ references: "<ok@x.example>\r\nBcc: evil@x.example>" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("mail_header_invalid");
    expect(r.field).toBe("references");
  });

  test("rejects a non-hex threadId", () => {
    const r = parseMailThreading({ threadId: "1a13940ce0564833\nTo: other" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("mail_header_invalid");
  });

  test("reads conversation.threadId when surface is mail", () => {
    const r = parseMailThreading({}, { surface: "mail", threadId: "1a13940ce0564833" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.threading.threadId).toBe("1a13940ce0564833");
  });
});

describe("parseMailEnvelope", () => {
  test("rejects CRLF in subject / to / from", () => {
    expect(parseMailEnvelope({ subject: "hi\r\nBcc: evil@x.example" }).ok).toBe(false);
    expect(parseMailEnvelope({ to: "ok@x.example\r\nBcc: evil@x.example" }).ok).toBe(false);
    expect(parseMailEnvelope({ from: "ok@x.example\nBcc: evil@x.example" }).ok).toBe(false);
    expect(parseMailEnvelope({ cc: ["ok@x.example\r\nBcc: evil@x.example"] }).ok).toBe(false);
  });

  test("accepts a normal envelope", () => {
    const r = parseMailEnvelope({
      from: "tando@tokyo307inc.com",
      to: "info@s-value.co.jp",
      subject: "Staffpass サービス概要",
    });
    expect(r.ok).toBe(true);
  });
});

describe("mailProviderIsGmail", () => {
  test("true for provider=gmail or mail surface or gmail surface", () => {
    expect(mailProviderIsGmail({ provider: "gmail" })).toBe(true);
    expect(mailProviderIsGmail({}, { surface: "gmail" })).toBe(true);
    expect(mailProviderIsGmail({}, { surface: "mail" })).toBe(true);
    expect(mailProviderIsGmail({}, { surface: "slack" })).toBe(false);
  });
});
