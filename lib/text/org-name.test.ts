/**
 * lib/text/org-name.ts tests
 * ORG_NAME_INPUT_STRICT_ENABLED (default OFF):
 * - When ON: reject bidi / zero-width / invisible / control / URL-like strings at input
 * - When OFF: existing behavior preserved
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const FLAG = "ORG_NAME_INPUT_STRICT_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => {
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

// Test imports will fail until implementation exists
import {
  sanitizeTextForMail,
  validateOrgNameStrict,
  ORG_NAME_MAX_LENGTH,
  ORG_NAME_MAX_LENGTH_ADMIN,
  countCodePoints,
} from "./org-name";

describe("sanitizeTextForMail", () => {
  test("strips control characters and line breaks", () => {
    expect(sanitizeTextForMail("ab\r\ncd\u0000ef", 200)).toBe("abcdef");
    expect(sanitizeTextForMail("hello\u0009world", 200)).toBe("helloworld");
  });

  test("strips bidi characters (U+202A-202E, U+2066-2069, U+200E/F, U+061C)", () => {
    // U+202A-202E: LRE, RLE, PDF, LRO, RLO
    expect(sanitizeTextForMail("a\u202Ab\u202Bc\u202Cd\u202De\u202Ef", 200)).toBe("abcdef");
    // U+2066-2069: LRI, RLI, FSI, PDI
    expect(sanitizeTextForMail("a\u2066b\u2067c\u2068d\u2069e", 200)).toBe("abcde");
    // U+200E/F: LRM, RLM
    expect(sanitizeTextForMail("a\u200Eb\u200Fc", 200)).toBe("abc");
    // U+061C: ALM (Arabic Letter Mark)
    expect(sanitizeTextForMail("a\u061Cb", 200)).toBe("ab");
  });

  test("strips zero-width and invisible characters (U+200B-200D, U+2060, U+FEFF, U+00AD, U+180E)", () => {
    // U+200B-200D: ZWSP, ZWNJ, ZWJ
    expect(sanitizeTextForMail("a\u200Bb\u200Cc\u200Dd", 200)).toBe("abcd");
    // U+2060: Word Joiner
    expect(sanitizeTextForMail("a\u2060b", 200)).toBe("ab");
    // U+FEFF: BOM / ZWNBSP
    expect(sanitizeTextForMail("a\uFEFFb", 200)).toBe("ab");
    // U+00AD: Soft Hyphen (新規追加)
    expect(sanitizeTextForMail("a\u00ADb", 200)).toBe("ab");
    // U+180E: Mongolian Vowel Separator (新規追加)
    expect(sanitizeTextForMail("a\u180Eb", 200)).toBe("ab");
  });

  test("replaces U+00A0 (NBSP) with regular space", () => {
    expect(sanitizeTextForMail("hello\u00A0world", 200)).toBe("hello world");
  });

  test("collapses consecutive spaces", () => {
    expect(sanitizeTextForMail("hello   world", 200)).toBe("hello world");
    expect(sanitizeTextForMail("a \t b", 200)).toBe("a b");
  });

  test("trims and caps length", () => {
    expect(sanitizeTextForMail("  hello  ", 200)).toBe("hello");
    expect(sanitizeTextForMail("a".repeat(300), 100)).toBe("a".repeat(100));
  });

  test("preserves Japanese text", () => {
    expect(sanitizeTextForMail("株式会社スペースツリー", 200)).toBe("株式会社スペースツリー");
    expect(sanitizeTextForMail("一般社団法人みらい社中", 200)).toBe("一般社団法人みらい社中");
  });

  test("preserves full-width space (U+3000) as-is", () => {
    // 全角スペースは日本語の社名で普通に使われるのでそのまま残す
    expect(sanitizeTextForMail("株式会社\u3000テスト", 200)).toBe("株式会社\u3000テスト");
  });
});

describe("validateOrgNameStrict (flag OFF by default)", () => {
  test("flag defaults to OFF", () => {
    // When flag is OFF, strict validation should pass for any non-empty org name
    const result = validateOrgNameStrict("test\u202Eorg");
    expect(result.ok).toBe(true);
  });

  test("when OFF, passes org name with bidi characters", () => {
    const result = validateOrgNameStrict("株式会社\u202Eテスト");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("株式会社テスト"); // NFKC normalized, bidi stripped by base validation
    }
  });
});

describe("validateOrgNameStrict (flag ON)", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  describe("repeated calls with same input (regex /g flag regression)", () => {
    test("control chars rejected on all 3 consecutive calls", () => {
      const input = "株式会社\r\nテスト";
      expect(validateOrgNameStrict(input).ok).toBe(false);
      expect(validateOrgNameStrict(input).ok).toBe(false);
      expect(validateOrgNameStrict(input).ok).toBe(false);
    });

    test("bidi chars rejected on all 3 consecutive calls", () => {
      const input = "Test\u202EOrg";
      expect(validateOrgNameStrict(input).ok).toBe(false);
      expect(validateOrgNameStrict(input).ok).toBe(false);
      expect(validateOrgNameStrict(input).ok).toBe(false);
    });

    test("invisible chars rejected on all 3 consecutive calls", () => {
      const input = "Test\u200BOrg";
      expect(validateOrgNameStrict(input).ok).toBe(false);
      expect(validateOrgNameStrict(input).ok).toBe(false);
      expect(validateOrgNameStrict(input).ok).toBe(false);
    });

    test("URL-like rejected on all 3 consecutive calls", () => {
      const input = "https://example.com";
      expect(validateOrgNameStrict(input).ok).toBe(false);
      expect(validateOrgNameStrict(input).ok).toBe(false);
      expect(validateOrgNameStrict(input).ok).toBe(false);
    });
  });

  describe("basic validation", () => {
    test("rejects empty org name", () => {
      const result = validateOrgNameStrict("");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("入力");
    });

    test("rejects org name exceeding max length", () => {
      const result = validateOrgNameStrict("a".repeat(ORG_NAME_MAX_LENGTH + 1));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("文字");
    });

    test("rejects control characters", () => {
      const result = validateOrgNameStrict("株式会社\u0000テスト");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("制御文字");
        expect(result.message).not.toContain("株式会社"); // 入力値を返さない
      }
    });

    test("rejects CR/LF", () => {
      const result = validateOrgNameStrict("株式会社\r\nテスト");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("制御文字");
    });
  });

  describe("bidi characters rejection", () => {
    test("rejects U+202A-202E (LRE, RLE, PDF, LRO, RLO)", () => {
      for (const char of ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E"]) {
        const result = validateOrgNameStrict(`株式会社${char}テスト`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain("双方向");
      }
    });

    test("rejects U+2066-2069 (LRI, RLI, FSI, PDI)", () => {
      for (const char of ["\u2066", "\u2067", "\u2068", "\u2069"]) {
        const result = validateOrgNameStrict(`Test${char}Corp`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain("双方向");
      }
    });

    test("rejects U+200E/F (LRM, RLM)", () => {
      expect(validateOrgNameStrict("Test\u200ECorp").ok).toBe(false);
      expect(validateOrgNameStrict("Test\u200FCorp").ok).toBe(false);
    });

    test("rejects U+061C (ALM)", () => {
      const result = validateOrgNameStrict("Test\u061CCorp");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("双方向");
    });
  });

  describe("zero-width and invisible characters rejection", () => {
    test("rejects U+200B-200D (ZWSP, ZWNJ, ZWJ)", () => {
      for (const char of ["\u200B", "\u200C", "\u200D"]) {
        const result = validateOrgNameStrict(`Test${char}Corp`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain("不可視");
      }
    });

    test("rejects U+2060 (Word Joiner)", () => {
      const result = validateOrgNameStrict("Test\u2060Corp");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("不可視");
    });

    test("rejects U+FEFF (BOM) in middle of string", () => {
      // Note: BOM at the start is stripped by trim(), so test middle position
      const result = validateOrgNameStrict("Test\uFEFFCorp");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("不可視");
    });

    test("rejects U+00AD (Soft Hyphen)", () => {
      const result = validateOrgNameStrict("Test\u00ADCorp");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("不可視");
    });

    test("rejects U+180E (Mongolian Vowel Separator)", () => {
      const result = validateOrgNameStrict("Test\u180ECorp");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("不可視");
    });
  });

  describe("URL-like string rejection", () => {
    // === Schemes (always reject) ===
    test("rejects http:// scheme", () => {
      const result = validateOrgNameStrict("http://example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects https:// scheme", () => {
      const result = validateOrgNameStrict("株式会社 https://evil.com テスト");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects javascript: scheme", () => {
      const result = validateOrgNameStrict("javascript:alert(1)");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects data: scheme", () => {
      const result = validateOrgNameStrict("data:text/html,<script>");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects vbscript: scheme", () => {
      const result = validateOrgNameStrict("vbscript:msgbox");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects file: scheme", () => {
      const result = validateOrgNameStrict("file:///etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects mailto: with @", () => {
      const result = validateOrgNameStrict("mailto:admin@example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects hxxp:// obfuscated scheme", () => {
      expect(validateOrgNameStrict("hxxp://example.com").ok).toBe(false);
    });

    test("rejects hxxps:// obfuscated scheme", () => {
      expect(validateOrgNameStrict("hxxps://example.com").ok).toBe(false);
    });

    test("rejects ftp:// scheme", () => {
      expect(validateOrgNameStrict("ftp://ftp.example.com").ok).toBe(false);
    });

    test("rejects scheme with space before colon (http ://)", () => {
      expect(validateOrgNameStrict("http ://example.com").ok).toBe(false);
    });

    test("rejects scheme with space inside (ht tp://)", () => {
      expect(validateOrgNameStrict("ht tp://x").ok).toBe(false);
    });

    test("rejects scheme with multiple spaces inside (h t t p s://)", () => {
      expect(validateOrgNameStrict("h t t p s://example.com").ok).toBe(false);
    });

    test("rejects scheme with NBSP before colon", () => {
      expect(validateOrgNameStrict("http\u00A0://example.com").ok).toBe(false);
    });

    test("rejects scheme with combining characters", () => {
      expect(validateOrgNameStrict("h\u0301ttp://example.com").ok).toBe(false);
    });

    // === www. prefix (always reject) ===
    test("rejects www. prefix", () => {
      expect(validateOrgNameStrict("www.evil.com").ok).toBe(false);
    });

    test("rejects fullwidth www. prefix (ｗｗｗ．)", () => {
      expect(validateOrgNameStrict("ｗｗｗ．evil．com").ok).toBe(false);
    });

    // === xn-- punycode (always reject) ===
    test("rejects punycode label (xn--)", () => {
      expect(validateOrgNameStrict("xn--n3h").ok).toBe(false);
    });

    test("rejects punycode with domain", () => {
      expect(validateOrgNameStrict("xn--n3h.com").ok).toBe(false);
    });

    // === @ (always reject) ===
    test("rejects @", () => {
      expect(validateOrgNameStrict("a@b").ok).toBe(false);
    });

    test("rejects fullwidth @ (＠)", () => {
      expect(validateOrgNameStrict("a＠b").ok).toBe(false);
    });

    // === / and // (always reject) ===
    test("rejects /", () => {
      expect(validateOrgNameStrict("a/b").ok).toBe(false);
    });

    test("rejects //", () => {
      expect(validateOrgNameStrict("//evil").ok).toBe(false);
    });

    test("rejects fullwidth // (／／)", () => {
      expect(validateOrgNameStrict("／／evil").ok).toBe(false);
    });

    test("rejects path-like patterns", () => {
      expect(validateOrgNameStrict("evil.co.jp/x").ok).toBe(false);
      expect(validateOrgNameStrict("192.168.1.1/admin").ok).toBe(false);
    });

    // === Host with port (always reject) ===
    test("rejects domain with port", () => {
      expect(validateOrgNameStrict("evil.com:8080").ok).toBe(false);
    });

    test("rejects IPv4 with port", () => {
      expect(validateOrgNameStrict("1.2.3.4:80").ok).toBe(false);
    });

    // === Allowed: names with only dots (no scheme, www., xn--, @, /, port) ===
    test("allows Sealith.AI (dot-containing company name)", () => {
      expect(validateOrgNameStrict("Sealith.AI").ok).toBe(true);
    });

    test("allows Next.js 勉強会", () => {
      expect(validateOrgNameStrict("Next.js 勉強会").ok).toBe(true);
    });

    test("allows 株式会社 A.B.C", () => {
      expect(validateOrgNameStrict("株式会社 A.B.C").ok).toBe(true);
    });

    test("allows example.com (domain-like but no dangerous pattern)", () => {
      expect(validateOrgNameStrict("example.com").ok).toBe(true);
    });

    test("allows IPv4 without port (1.2.3.4)", () => {
      expect(validateOrgNameStrict("1.2.3.4").ok).toBe(true);
    });

    test("allows File : Notes", () => {
      expect(validateOrgNameStrict("File : Notes").ok).toBe(true);
    });

    test("allows domain-like in Japanese text (株式会社 malware.org テスト)", () => {
      expect(validateOrgNameStrict("株式会社 malware.org テスト").ok).toBe(true);
    });

    test("allows Japanese text adjacent to domain-like (株式会社malware.com)", () => {
      expect(validateOrgNameStrict("株式会社malware.com").ok).toBe(true);
    });

    test("allows domain adjacent to Japanese (note.com株式会社)", () => {
      expect(validateOrgNameStrict("note.com株式会社").ok).toBe(true);
    });

    test("allows Japanese domain (日本語.com)", () => {
      expect(validateOrgNameStrict("日本語.com").ok).toBe(true);
    });

    test("allows fullwidth dot in domain-like (example。com normalizes)", () => {
      expect(validateOrgNameStrict("example。com").ok).toBe(true);
    });

    test("allows colon with spaces (no scheme pattern)", () => {
      expect(validateOrgNameStrict("Data : Science").ok).toBe(true);
      expect(validateOrgNameStrict("HTTP : Status").ok).toBe(true);
      expect(validateOrgNameStrict("File : Notes").ok).toBe(true);
    });

    // === HIGH-1: Whitespace-separated schemes must be rejected ===
    test("rejects javascript: with spaces (java script:)", () => {
      expect(validateOrgNameStrict("java script:alert(1)").ok).toBe(false);
    });

    test("rejects mailto: with spaces (mail to:)", () => {
      expect(validateOrgNameStrict("mail to:admin").ok).toBe(false);
    });

    test("rejects vbscript: with spaces (vb script:)", () => {
      expect(validateOrgNameStrict("vb script:msgbox").ok).toBe(false);
    });

    test("rejects fullwidth javascript: with spaces (ｊａｖａ ｓｃｒｉｐｔ：)", () => {
      expect(validateOrgNameStrict("ｊａｖａ ｓｃｒｉｐｔ：x").ok).toBe(false);
    });

    test("rejects www. with spaces inside (w w w.)", () => {
      expect(validateOrgNameStrict("w w w.evil.com").ok).toBe(false);
    });

    test("rejects Mail To: John (matches mailto:)", () => {
      expect(validateOrgNameStrict("Mail To: John").ok).toBe(false);
    });

    test("rejects Java Script: Guide (matches javascript:)", () => {
      expect(validateOrgNameStrict("Java Script: Guide").ok).toBe(false);
    });

    test("rejects File: Notes (file: without space)", () => {
      expect(validateOrgNameStrict("File: Notes").ok).toBe(false);
    });

    test("allows Data : Science (data: with space before colon)", () => {
      expect(validateOrgNameStrict("Data : Science").ok).toBe(true);
    });

    // === HIGH-2: Host with port pattern improvements ===
    test("rejects IPv6 with port ([::1]:80)", () => {
      expect(validateOrgNameStrict("[::1]:80").ok).toBe(false);
    });

    test("rejects bare IPv6 with port (::1:80)", () => {
      expect(validateOrgNameStrict("::1:80").ok).toBe(false);
    });

    test("rejects domain:port with query (a.com:80?x)", () => {
      expect(validateOrgNameStrict("a.com:80?x").ok).toBe(false);
    });

    test("rejects domain:port with fragment (a.com:80#x)", () => {
      expect(validateOrgNameStrict("a.com:80#x").ok).toBe(false);
    });

    test("rejects domain:port with space after colon (a.com: 80)", () => {
      expect(validateOrgNameStrict("a.com: 80").ok).toBe(false);
    });

    test("rejects domain:port with fullwidth colon (a.com：80)", () => {
      expect(validateOrgNameStrict("a.com：80").ok).toBe(false);
    });

    test("rejects Japanese adjacent domain:port (株式会社a.com:443)", () => {
      expect(validateOrgNameStrict("株式会社a.com:443").ok).toBe(false);
    });

    test("allows time-like patterns (株式会社 3:2)", () => {
      expect(validateOrgNameStrict("株式会社 3:2").ok).toBe(true);
    });

    test("allows time-like patterns (10:30 Labs)", () => {
      expect(validateOrgNameStrict("10:30 Labs").ok).toBe(true);
    });

    test("allows ratio patterns (Ratio 16:9 Inc)", () => {
      expect(validateOrgNameStrict("Ratio 16:9 Inc").ok).toBe(true);
    });

    // === MEDIUM-2: Slash-like characters ===
    test("rejects division slash U+2215 (a∕b)", () => {
      expect(validateOrgNameStrict("a\u2215b").ok).toBe(false);
    });

    test("rejects fraction slash U+2044 (a⁄b)", () => {
      expect(validateOrgNameStrict("a\u2044b").ok).toBe(false);
    });

    test("rejects big solidus U+29F8 (a⧸b)", () => {
      expect(validateOrgNameStrict("a\u29F8b").ok).toBe(false);
    });

    test("rejects box drawings light diagonal U+2571 (a╱b)", () => {
      expect(validateOrgNameStrict("a\u2571b").ok).toBe(false);
    });
  });

  describe("false positive avoidance: allowed company name patterns", () => {
    test("allows Japanese company names", () => {
      expect(validateOrgNameStrict("株式会社スペースツリー").ok).toBe(true);
      expect(validateOrgNameStrict("一般社団法人みらい社中").ok).toBe(true);
      expect(validateOrgNameStrict("有限会社山田商店").ok).toBe(true);
    });

    test("allows English company names", () => {
      expect(validateOrgNameStrict("TOKYO307 Inc.").ok).toBe(true);
      expect(validateOrgNameStrict("A&B Co., Ltd.").ok).toBe(true);
      expect(validateOrgNameStrict("Smith & Associates LLC").ok).toBe(true);
    });

    test("allows company names with Co., Ltd.", () => {
      const result = validateOrgNameStrict("Example Co., Ltd.");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("Example Co., Ltd.");
    });

    test("allows company names with Inc.", () => {
      const result = validateOrgNameStrict("Test Corp Inc.");
      expect(result.ok).toBe(true);
    });

    test("allows full-width space (正規化後)", () => {
      const result = validateOrgNameStrict("株式会社　テスト");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("株式会社 テスト");
      }
    });

    test("allows regular period in company names", () => {
      expect(validateOrgNameStrict("T.K. Holdings").ok).toBe(true);
      expect(validateOrgNameStrict("Dr. Smith Associates").ok).toBe(true);
    });

    test("does not reject single TLD-like words", () => {
      // 2文字以上の英字だけではドメインと判定しない
      expect(validateOrgNameStrict("JP Corp").ok).toBe(true);
      expect(validateOrgNameStrict("IT Solutions").ok).toBe(true);
    });

    test("does not reject numbers with periods", () => {
      // バージョン番号のような数字+ピリオドはOK
      expect(validateOrgNameStrict("Version 2.0 Inc").ok).toBe(true);
    });
  });

  describe("error messages do not echo input", () => {
    test("bidi error message does not contain input", () => {
      const result = validateOrgNameStrict("Evil\u202EOrg");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).not.toContain("Evil");
        expect(result.message).not.toContain("Org");
      }
    });

    test("URL error message does not contain input", () => {
      const result = validateOrgNameStrict("http://malware.site");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).not.toContain("malware");
        expect(result.message).not.toContain("http");
      }
    });
  });

  describe("length limits and code point counting", () => {
    test("countCodePoints counts surrogate pairs as 1", () => {
      // 𠮷 (U+20BB7) is a CJK Extension B character, 2 UTF-16 code units
      expect(countCodePoints("𠮷")).toBe(1);
      expect("𠮷".length).toBe(2);  // JavaScript string length
      expect(countCodePoints("a𠮷b")).toBe(3);
      expect("a𠮷b".length).toBe(4);  // JavaScript string length
    });

    test("countCodePoints counts emoji correctly", () => {
      // 👍 (U+1F44D) is 2 UTF-16 code units
      expect(countCodePoints("👍")).toBe(1);
      expect("👍".length).toBe(2);
    });

    test("default max length is 100", () => {
      expect(ORG_NAME_MAX_LENGTH).toBe(100);
    });

    test("admin max length is 200", () => {
      expect(ORG_NAME_MAX_LENGTH_ADMIN).toBe(200);
    });

    test("rejects string with 101+ code points at default limit", () => {
      const input = "株".repeat(101);  // 101 code points (each 株 is 1 code point)
      const result = validateOrgNameStrict(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("100文字");
      }
    });

    test("accepts string with exactly 100 code points at default limit", () => {
      const input = "株".repeat(100);
      const result = validateOrgNameStrict(input);
      expect(result.ok).toBe(true);
    });

    test("accepts string with 150 code points at admin limit (200)", () => {
      const input = "株".repeat(150);
      const result = validateOrgNameStrict(input, ORG_NAME_MAX_LENGTH_ADMIN);
      expect(result.ok).toBe(true);
    });

    test("rejects string with 201+ code points at admin limit (200)", () => {
      const input = "株".repeat(201);
      const result = validateOrgNameStrict(input, ORG_NAME_MAX_LENGTH_ADMIN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("200文字");
      }
    });

    test("counts surrogate pairs correctly for length limit", () => {
      // 100 surrogate pair characters = 100 code points, 200 UTF-16 units
      const input = "𠮷".repeat(100);
      expect(input.length).toBe(200);  // UTF-16 units
      expect(countCodePoints(input)).toBe(100);  // code points
      const result = validateOrgNameStrict(input);
      expect(result.ok).toBe(true);  // passes because 100 code points <= 100
    });

    test("rejects 101 surrogate pair characters at default limit", () => {
      const input = "𠮷".repeat(101);
      expect(input.length).toBe(202);  // UTF-16 units
      expect(countCodePoints(input)).toBe(101);  // code points
      const result = validateOrgNameStrict(input);
      expect(result.ok).toBe(false);  // fails because 101 code points > 100
    });
  });
});
