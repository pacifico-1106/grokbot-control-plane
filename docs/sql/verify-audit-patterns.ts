#!/usr/bin/env bun
/**
 * verify-audit-patterns.ts
 * Verify that the SQL audit patterns match all rejection cases from the app.
 *
 * Usage: bun run docs/sql/verify-audit-patterns.ts
 *
 * This script tests that the SQL patterns (converted to JS regex) catch all
 * org names that the app would reject.
 */

// SQL patterns converted to JS regex
// Note: These must match the patterns in org-name-strict-audit.sql

const PATTERNS = {
  // ドット系: . 。 ． ｡
  dot: /[.\u3002\uff0e\uff61]/,
  // コロン系: : ：
  colon: /[:\uff1a]/,
  // スラッシュ系: / ／
  slash: /[/\uff0f]/,
  // @
  at: /@/,
  // 制御文字: U+0000–001F, U+007F–009F, U+2028, U+2029
  control: /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/,
  // bidi 文字: U+202A–202E, U+2066–2069, U+200E/F, U+061C
  bidi: /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/,
  // ゼロ幅・不可視文字: U+200B–200D, U+2060–2065, U+FEFF, U+00AD, U+180E
  invisible: /[\u200b-\u200d\u2060-\u2065\ufeff\u00ad\u180e]/,
  // 結合文字: U+0300–036F, U+1AB0–1AFF, U+1DC0–1DFF, U+20D0–20FF, U+FE20–FE2F
  combining: /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/,
  // 全角英数字: U+FF01–FF5E
  fullwidth: /[\uff01-\uff5e]/,
  // Punycode ラベル: xn-- (ドットなしも検出)
  punycode: /(^|[\s.])xn--[a-z0-9-]+/i,
};

function matchesAnyPattern(name: string): string[] {
  const matched: string[] = [];
  for (const [key, pattern] of Object.entries(PATTERNS)) {
    if (pattern.test(name)) matched.push(key);
  }
  // Length > 100 code points
  if ([...name].length > 100) matched.push("too_long");
  return matched;
}

// Test samples that should be rejected by the app (from org-name.test.ts)
const REJECTION_SAMPLES: Array<{ name: string; description: string }> = [
  // Control characters
  { name: "株式会社\u0000テスト", description: "null char" },
  { name: "株式会社\r\nテスト", description: "CRLF" },

  // Bidi characters
  { name: "Test\u202EOrg", description: "RLO" },
  { name: "Test\u2066Corp", description: "LRI" },
  { name: "Test\u200ECorp", description: "LRM" },
  { name: "Test\u061CCorp", description: "ALM" },

  // Zero-width / invisible characters
  { name: "Test\u200BOrg", description: "ZWSP" },
  { name: "Test\u200COrg", description: "ZWNJ" },
  { name: "Test\u200DOrg", description: "ZWJ" },
  { name: "Test\u2060Corp", description: "Word Joiner" },
  { name: "Test\uFEFFCorp", description: "BOM" },
  { name: "Test\u00ADCorp", description: "Soft Hyphen" },
  { name: "Test\u180ECorp", description: "Mongolian Vowel Separator" },
  { name: "Test\u2061Corp", description: "Function Application U+2061" },
  { name: "Test\u2065Corp", description: "U+2065" },

  // URL schemes
  { name: "http://example.com", description: "http scheme" },
  { name: "https://evil.com", description: "https scheme" },
  { name: "javascript:alert(1)", description: "javascript scheme" },
  { name: "data:text/html,<script>", description: "data scheme" },
  { name: "vbscript:msgbox", description: "vbscript scheme" },
  { name: "file:///etc/passwd", description: "file scheme" },
  { name: "mailto:admin@example.com", description: "mailto scheme" },
  { name: "hxxp://example.com", description: "hxxp obfuscated" },
  { name: "hxxps://example.com", description: "hxxps obfuscated" },
  { name: "ftp://ftp.example.com", description: "ftp scheme" },

  // URL with spaces in scheme
  { name: "http ://example.com", description: "space before colon" },
  { name: "ht tp://example.com", description: "space inside scheme" },
  { name: "http\u00A0://example.com", description: "NBSP before colon" },

  // Domain patterns
  { name: "www.example.com", description: "www prefix" },
  { name: "example.com", description: "domain" },
  { name: "evil.co.jp/x", description: "ccTLD with path" },
  { name: "株式会社 malware.org テスト", description: "domain in text" },

  // IPv4
  { name: "192.168.1.1", description: "IPv4" },
  { name: "192.168.1.1/admin", description: "IPv4 with path" },

  // Fullwidth characters (normalized to URL by app)
  { name: "example\u3002com", description: "fullwidth dot 。" },
  { name: "example\uff0ecom", description: "fullwidth dot ．" },

  // Punycode
  { name: "xn--n3h.com", description: "punycode with dot" },
  { name: "xn--nxasmq5b", description: "punycode without dot" },

  // Japanese adjacent domain
  { name: "株式会社malware.com", description: "Japanese prefix + domain" },
  { name: "note.com株式会社", description: "domain + Japanese suffix" },
  { name: "日本語.com", description: "Japanese domain label" },

  // Combining characters
  { name: "h\u0301ttp://example.com", description: "combining acute accent" },

  // Length > 100
  { name: "あ".repeat(101), description: "101 code points" },

  // Fullwidth alphanumeric
  { name: "\uff28\uff54\uff54\uff50://example.com", description: "fullwidth Ｈｔｔｐ" },
];

console.log("Verifying SQL audit patterns against app rejection samples...\n");

let passed = 0;
let failed = 0;

for (const sample of REJECTION_SAMPLES) {
  const matches = matchesAnyPattern(sample.name);
  if (matches.length > 0) {
    passed++;
    console.log(`✓ ${sample.description}: [${matches.join(", ")}]`);
  } else {
    failed++;
    console.log(`✗ ${sample.description}: NOT CAUGHT`);
    console.log(`  Name: ${JSON.stringify(sample.name)}`);
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Total: ${REJECTION_SAMPLES.length} samples`);
console.log(`Caught: ${passed}`);
console.log(`Missed: ${failed}`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  console.log("\n⚠ Some samples were not caught by the SQL patterns!");
  console.log("Update the SQL or document the gap.\n");
  process.exit(1);
} else {
  console.log("\n✓ All samples are caught by the SQL audit patterns.\n");
  process.exit(0);
}
