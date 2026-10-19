#!/usr/bin/env bun
/**
 * verify-audit-patterns.ts
 * Verify that the SQL audit patterns match all rejection cases from the app.
 *
 * Usage: bun run docs/sql/verify-audit-patterns.ts
 *
 * This script tests that the SQL patterns (converted to JS regex) catch all
 * org names that the app would reject.
 *
 * Rejection criteria:
 * - Schemes (including whitespace-separated javascript:, vbscript:, mailto:)
 * - www. (including whitespace-separated)
 * - xn-- (punycode)
 * - @ (including fullwidth and small commercial at)
 * - / (including slash-like characters)
 * - host:port (domain, IPv4, IPv6)
 * - control, bidi, invisible characters
 * - too_long (> 100 code points)
 *
 * Allow:
 * - Names with only dots (Sealith.AI, example.com, 1.2.3.4 without port)
 * - Time/ratio patterns (10:30, 16:9)
 * - Combining characters (café - stripped before URL check)
 */

// SQL patterns converted to JS regex
const PATTERNS = {
  // スラッシュ系: / ／ ∕ ⁄ ⧸ ╱
  slash: /[/\uff0f\u2215\u2044\u29f8\u2571]/,
  // @ 系: @ ＠ ﹫
  at: /[@\uff20\ufe6b]/,
  // コロン系: : ：
  colon: /[:\uff1a]/,
  // www パターン (空白を挟んでも拾う)
  www: /w[\s]*w[\s]*w[\s]*\./i,
  // Punycode ラベル: xn--
  punycode: /(^|[\s.])xn--[a-z0-9-]*/i,
  // IPv6 関連: [ または ::
  ipv6: /\[|::/,
  // URL クエリ/フラグメント: ? または #
  url_suffix: /[?#]/,
  // 制御文字: U+0000–001F, U+007F–009F, U+2028, U+2029
  control: /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/,
  // bidi 文字: U+202A–202E, U+2066–2069, U+200E/F, U+061C
  bidi: /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/,
  // ゼロ幅・不可視文字: U+200B–200D, U+2060–2065, U+FEFF, U+00AD, U+180E
  invisible: /[\u200b-\u200d\u2060-\u2065\ufeff\u00ad\u180e]/,
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

// Test samples that should be REJECTED by the app
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

  // URL schemes (has : and /)
  { name: "http://example.com", description: "http scheme" },
  { name: "https://evil.com", description: "https scheme" },
  { name: "javascript:alert(1)", description: "javascript scheme" },
  { name: "data:text/html,<script>", description: "data scheme" },
  { name: "hxxp://example.com", description: "hxxp obfuscated" },
  { name: "ftp://ftp.example.com", description: "ftp scheme" },

  // Whitespace-separated dangerous schemes (HIGH-1)
  { name: "java script:alert(1)", description: "whitespace javascript:" },
  { name: "mail to:admin", description: "whitespace mailto:" },
  { name: "vb script:msgbox", description: "whitespace vbscript:" },
  { name: "\uff4a\uff41\uff56\uff41 \uff53\uff43\uff52\uff49\uff50\uff54\uff1ax", description: "fullwidth javascript:" },
  { name: "Mail To: John", description: "Mail To: John" },
  { name: "Java Script: Guide", description: "Java Script: Guide" },
  { name: "File: Notes", description: "File: Notes (no space)" },

  // www. prefix
  { name: "www.example.com", description: "www prefix" },
  { name: "\uff57\uff57\uff57\uff0eevil.com", description: "fullwidth www." },
  { name: "w w w.evil.com", description: "whitespace www." },

  // @ sign
  { name: "a@b", description: "@ sign" },
  { name: "admin@example.com", description: "email-like" },
  { name: "a\uff20b", description: "fullwidth @" },
  { name: "a\ufe6bb", description: "small commercial at" },

  // / and // (including slash-like characters)
  { name: "a/b", description: "slash" },
  { name: "//evil", description: "double slash" },
  { name: "\uff0f\uff0fevil", description: "fullwidth //" },
  { name: "a\u2215b", description: "division slash U+2215" },
  { name: "a\u2044b", description: "fraction slash U+2044" },
  { name: "a\u29f8b", description: "big solidus U+29F8" },
  { name: "a\u2571b", description: "box drawings U+2571" },

  // Host with port (HIGH-2)
  { name: "evil.com:8080", description: "domain with port" },
  { name: "1.2.3.4:80", description: "IPv4 with port" },
  { name: "[::1]:80", description: "IPv6 with port" },
  { name: "::1:80", description: "bare IPv6 with port" },
  { name: "a.com:80?x", description: "domain:port with query" },
  { name: "a.com:80#x", description: "domain:port with fragment" },
  { name: "a.com: 80", description: "domain:port with space" },
  { name: "a.com\uff1a80", description: "domain:port fullwidth colon" },
  { name: "株式会社a.com:443", description: "Japanese adjacent domain:port" },

  // Punycode
  { name: "xn--n3h", description: "punycode without dot" },
  { name: "xn--nxasmq5b", description: "punycode label" },

  // Length > 100
  { name: "あ".repeat(101), description: "101 code points" },
];

// Test samples that should be ALLOWED by the app (not caught by SQL for dot-only names)
const ALLOWED_SAMPLES: Array<{ name: string; description: string }> = [
  { name: "Sealith.AI", description: "dot-containing company name" },
  { name: "Next.js 勉強会", description: "JS library name" },
  { name: "株式会社 A.B.C", description: "Japanese company with dots" },
  { name: "example.com", description: "domain-like (no dangerous pattern)" },
  { name: "1.2.3.4", description: "IPv4 without port" },
  { name: "株式会社malware.com", description: "Japanese adjacent domain" },
  { name: "note.com株式会社", description: "domain adjacent Japanese" },
  { name: "日本語.com", description: "Japanese domain" },
  { name: "T.K. Holdings", description: "initials with dots" },
  { name: "Version 2.0 Inc", description: "version number" },
  { name: "A&B Co., Ltd.", description: "company suffix" },
  { name: "TOKYO307 Inc.", description: "company name" },
  { name: "株式会社スペースツリー", description: "Japanese company no dots" },
  { name: "Dr. Smith Associates", description: "title with dot" },
  { name: "cafe\u0301", description: "café with combining (allowed)" },
];

// Samples that app ALLOWS but SQL flags (due to "広めに拾う" approach)
// These contain characters that SQL catches (like :) but app's smarter logic allows
const SQL_BROAD_CATCH_SAMPLES: Array<{ name: string; description: string; expectedPatterns: string[] }> = [
  { name: "File : Notes", description: "colon with spaces (no scheme)", expectedPatterns: ["colon"] },
  { name: "Data : Science", description: "data: with space", expectedPatterns: ["colon"] },
  { name: "株式会社 3:2", description: "time-like with space", expectedPatterns: ["colon"] },
  { name: "10:30 Labs", description: "time-like", expectedPatterns: ["colon"] },
  { name: "Ratio 16:9 Inc", description: "ratio pattern", expectedPatterns: ["colon"] },
];

console.log("Verifying SQL audit patterns against app samples...\n");

let rejectionPassed = 0;
let rejectionFailed = 0;

console.log("=== REJECTION SAMPLES (should be caught) ===\n");

for (const sample of REJECTION_SAMPLES) {
  const matches = matchesAnyPattern(sample.name);
  if (matches.length > 0) {
    rejectionPassed++;
    console.log(`✓ ${sample.description}: [${matches.join(", ")}]`);
  } else {
    rejectionFailed++;
    console.log(`✗ ${sample.description}: NOT CAUGHT`);
    console.log(`  Name: ${JSON.stringify(sample.name)}`);
  }
}

let allowedPassed = 0;
let allowedFailed = 0;

console.log("\n=== ALLOWED SAMPLES (should NOT be caught by SQL) ===\n");

for (const sample of ALLOWED_SAMPLES) {
  const matches = matchesAnyPattern(sample.name);
  if (matches.length === 0) {
    allowedPassed++;
    console.log(`✓ ${sample.description}: allowed (no matches)`);
  } else {
    allowedFailed++;
    console.log(`✗ ${sample.description}: incorrectly caught [${matches.join(", ")}]`);
    console.log(`  Name: ${JSON.stringify(sample.name)}`);
  }
}

let broadCatchPassed = 0;
let broadCatchFailed = 0;

console.log("\n=== SQL BROAD CATCH (app allows, SQL catches - expected) ===\n");

for (const sample of SQL_BROAD_CATCH_SAMPLES) {
  const matches = matchesAnyPattern(sample.name);
  const hasExpectedPatterns = sample.expectedPatterns.every(p => matches.includes(p));
  if (matches.length > 0 && hasExpectedPatterns) {
    broadCatchPassed++;
    console.log(`✓ ${sample.description}: SQL catches [${matches.join(", ")}] (app allows, expected)`);
  } else {
    broadCatchFailed++;
    console.log(`✗ ${sample.description}: unexpected behavior`);
    console.log(`  Expected: [${sample.expectedPatterns.join(", ")}]`);
    console.log(`  Got: [${matches.join(", ")}]`);
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Rejection samples: ${REJECTION_SAMPLES.length} total`);
console.log(`  Caught: ${rejectionPassed}`);
console.log(`  Missed: ${rejectionFailed}`);
console.log(`\nAllowed samples (not caught by SQL): ${ALLOWED_SAMPLES.length} total`);
console.log(`  Correctly allowed: ${allowedPassed}`);
console.log(`  Incorrectly caught: ${allowedFailed}`);
console.log(`\nSQL broad catch (app allows, SQL catches): ${SQL_BROAD_CATCH_SAMPLES.length} total`);
console.log(`  Correctly caught by SQL: ${broadCatchPassed}`);
console.log(`  Unexpected: ${broadCatchFailed}`);
console.log(`${"=".repeat(60)}`);

if (rejectionFailed > 0) {
  console.log("\n⚠ Some rejection samples were not caught by the SQL patterns!");
  console.log("Update the SQL or document the gap.\n");
  process.exit(1);
} else if (allowedFailed > 0) {
  console.log("\n⚠ Some allowed samples were incorrectly caught!");
  console.log("The SQL patterns are too broad.\n");
  process.exit(1);
} else if (broadCatchFailed > 0) {
  console.log("\n⚠ SQL broad catch samples behaved unexpectedly!");
  process.exit(1);
} else {
  console.log("\n✓ All rejection samples are caught by the SQL audit patterns.");
  console.log("✓ All allowed samples are correctly not caught.");
  console.log("✓ SQL broad catch samples behave as expected (SQL catches, app allows).\n");
  process.exit(0);
}
