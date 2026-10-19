/**
 * LP_INQUIRY_FIXED_SUBJECT_ENABLED (default OFF).
 * When ON: subject is fixed text + receipt id only. User input lives only in
 * escaped body fields (no mailto / URL links, control chars stripped, length
 * capped). When OFF: today's subject `【AI社員パック問い合わせ】{会社} - {名前}様`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isLpInquiryFixedSubjectEnabled } from "@/lib/feature-flags";
import {
  LP_INQUIRY_FIELD_MAX,
  LP_INQUIRY_SUBJECT_PREFIX,
  allocateInquiryReceiptId,
  buildInquiryNotify,
  sanitizeInquiryPlainText,
} from "./inquiry-mail";

const FLAG = "LP_INQUIRY_FIXED_SUBJECT_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => {
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const XSS = `<a href="https://evil.example">click</a>\r\nBcc: x@evil.example`;
const input = {
  timestamp: "2026-10-19T00:00:00.000Z",
  inquiryId: "inq_abc123",
  planLabel: "インターン（¥50,000/月）",
  company: "株式会社テスト",
  name: "山田",
  email: "taro@example.jp",
  phone: "03-0000-0000",
  headcount: "5",
  billingLabel: "月払い",
  lpPageLabel: "/lp/ai-employee（個人・スタートアップ向け）",
  lpRef: null as string | null,
  useCase: "日報の下書きを任せたい https://evil.example",
};

describe("LP_INQUIRY_FIXED_SUBJECT_ENABLED flag", () => {
  test("defaults OFF", () => {
    expect(isLpInquiryFixedSubjectEnabled()).toBe(false);
  });
  test("accepts true/1/on/enabled", () => {
    process.env[FLAG] = "true";
    expect(isLpInquiryFixedSubjectEnabled()).toBe(true);
    process.env[FLAG] = "1";
    expect(isLpInquiryFixedSubjectEnabled()).toBe(true);
    process.env[FLAG] = "on";
    expect(isLpInquiryFixedSubjectEnabled()).toBe(true);
    process.env[FLAG] = "enabled";
    expect(isLpInquiryFixedSubjectEnabled()).toBe(true);
  });
});

describe("flag OFF: today's subject and mailto body", () => {
  test("subject still embeds company and name", () => {
    const mail = buildInquiryNotify(input);
    expect(mail.subject).toBe("【AI社員パック問い合わせ】株式会社テスト - 山田様");
    expect(mail.html).toBe("");
  });
});

describe("flag ON: fixed subject + escaped fields only", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  test("subject is prefix + receipt id; no company, name, or raw input", () => {
    const mail = buildInquiryNotify({ ...input, company: XSS, name: XSS });
    expect(mail.subject.startsWith(LP_INQUIRY_SUBJECT_PREFIX)).toBe(true);
    expect(mail.subject).toBe(`${LP_INQUIRY_SUBJECT_PREFIX}inq_abc123`);
    expect(mail.subject).not.toContain("株式会社");
    expect(mail.subject).not.toContain("evil");
    expect(mail.subject).not.toContain("山田");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  test("user input is only in escaped body cells", () => {
    const mail = buildInquiryNotify({ ...input, company: XSS, name: XSS, useCase: XSS });
    expect(mail.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(mail.html).not.toContain(`<a href="https://evil.example"`);
    expect(mail.html).not.toContain("<a href=");
    expect(mail.html).not.toContain("mailto:");
    expect(mail.html).toContain("Bcc: x@evil.example");
  });

  test("newlines and control characters are stripped; length is capped", () => {
    const dirty = `ab\r\ncd\u0000ef${"x".repeat(500)}`;
    expect(sanitizeInquiryPlainText(dirty, LP_INQUIRY_FIELD_MAX)).toBe(
      `abcdef${"x".repeat(LP_INQUIRY_FIELD_MAX - 6)}`
    );
    expect(sanitizeInquiryPlainText(dirty, LP_INQUIRY_FIELD_MAX).length).toBe(
      LP_INQUIRY_FIELD_MAX
    );
  });

  test("URLs in the body are not turned into links", () => {
    const mail = buildInquiryNotify(input);
    expect(mail.html).toContain("https://evil.example");
    expect(mail.html).not.toContain(`<a href="https://evil.example"`);
    expect(mail.html).not.toContain("mailto:");
  });

  test("receipt id falls back when inquiry id is missing or unsafe", () => {
    expect(allocateInquiryReceiptId("inq_ok")).toBe("inq_ok");
    expect(allocateInquiryReceiptId("<script>")).toMatch(/^R[A-Z0-9]+$/);
    expect(allocateInquiryReceiptId(null)).toMatch(/^R[A-Z0-9]+$/);
  });
});
