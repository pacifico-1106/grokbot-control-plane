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

  test("preserves full-width space as regular space", () => {
    // 全角スペースは NFKC 正規化で通常のスペースになる想定だが、明示的にテスト
    expect(sanitizeTextForMail("株式会社　テスト", 200)).toBe("株式会社 テスト");
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

    test("rejects mailto: scheme", () => {
      const result = validateOrgNameStrict("mailto:admin@example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects www. prefix", () => {
      const result = validateOrgNameStrict("www.example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects domain-like tokens (example.com)", () => {
      const result = validateOrgNameStrict("example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects domain-like tokens with path (evil.co.jp/x)", () => {
      const result = validateOrgNameStrict("evil.co.jp/x");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
    });

    test("rejects domain embedded in text", () => {
      const result = validateOrgNameStrict("株式会社 malware.org テスト");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("URL");
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
});
