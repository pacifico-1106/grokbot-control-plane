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
 * New criteria (simplified):
 * - Reject: schemes, www., xn--, @, /, //, host:port, control, bidi, invisible, combining, too_long
 * - Allow: names with only dots (Sealith.AI, example.com, 1.2.3.4 without port)
 */

// SQL patterns converted to JS regex
// Note: These must match the patterns in org-name-strict-audit.sql

const PATTERNS = {
  // スラッシュ系: / ／
  slash: /[/\uff0f]/,
  // @ 系: @ ＠
  at: /[@\uff20]/,
  // コロン系: : ：
  colon: /[:\uff1a]/,
  // www. パターン (半角/全角)
  www: /(^|[\s])www\./i,
  // Punycode ラベル: xn-- (ドットなしも検出)
  punycode: /(^|[\s.])xn--[a-z0-9-]*/i,
  // 制御文字: U+0000–001F, U+007F–009F, U+2028, U+2029
  control: /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/,
  // bidi 文字: U+202A–202E, U+2066–2069, U+200E/F, U+061C
  bidi: /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/,
  // ゼロ幅・不可視文字: U+200B–200D, U+2060–2065, U+FEFF, U+00AD, U+180E
  invisible: /[\u200b-\u200d\u2060-\u2065\ufeff\u00ad\u180e]/,
  // 結合文字: U+0300–036F, U+1AB0–1AFF, U+1DC0–1DFF, U+20D0–20FF, U+FE20–FE2F
  combining: /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/,
};

// Fullwidth www. pattern check
const FULLWIDTH_WWW = /\uff57\uff57\uff57\uff0e/i;

function matchesAnyPattern(name: string): string[] {
  const matched: string[] = [];
  for (const [key, pattern] of Object.entries(PATTERNS)) {
    if (pattern.test(name)) matched.push(key);
  }
  // Special check for fullwidth www.
  if (FULLWIDTH_WWW.test(name)) matched.push("www_fullwidth");
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

  // www. prefix
  { name: "www.example.com", description: "www prefix" },
  { name: "\uff57\uff57\uff57\uff0eevil.com", description: "fullwidth www." },

  // @ sign
  { name: "a@b", description: "@ sign" },
  { name: "admin@example.com", description: "email-like" },
  { name: "a\uff20b", description: "fullwidth @" },

  // / and //
  { name: "a/b", description: "slash" },
  { name: "//evil", description: "double slash" },
  { name: "\uff0f\uff0fevil", description: "fullwidth //" },

  // Host with port (has :)
  { name: "evil.com:8080", description: "domain with port" },
  { name: "1.2.3.4:80", description: "IPv4 with port" },

  // Punycode
  { name: "xn--n3h", description: "punycode without dot" },
  { name: "xn--nxasmq5b", description: "punycode label" },

  // Combining characters
  { name: "h\u0301ttp://example.com", description: "combining acute accent" },

  // Length > 100
  { name: "あ".repeat(101), description: "101 code points" },
];

// Test samples that should be ALLOWED by the app (dots only, no dangerous patterns)
// Note: SQL is "広めに拾う" (catches broadly), so some of these may be flagged by SQL
// but still allowed by the app. We test that dot-only names are not flagged.
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
];

// Samples that app ALLOWS but SQL flags (due to "広めに拾う" approach)
// These contain characters that SQL catches (like :) but app's smarter logic allows
const SQL_BROAD_CATCH_SAMPLES: Array<{ name: string; description: string; expectedPatterns: string[] }> = [
  { name: "File : Notes", description: "colon with spaces (no scheme)", expectedPatterns: ["colon"] },
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
