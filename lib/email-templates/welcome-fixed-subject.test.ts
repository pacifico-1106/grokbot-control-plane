/**
 * WELCOME_MAIL_FIXED_SUBJECT_ENABLED (default OFF).
 * When ON: signup welcome / trial_started / trial_ending subjects are fixed
 * Staffpass copy. orgName stays in the escaped, sanitized body only.
 * When OFF: today's subjects (orgName / trialDays interpolations).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_LABEL } from "@/lib/brand";
import { isWelcomeMailFixedSubjectEnabled } from "@/lib/feature-flags";
import { escapeHtml } from "@/lib/html-escape";
import { LP_INQUIRY_FIELD_MAX, sanitizeInquiryPlainText } from "@/lib/lp/inquiry-mail";
import { renderStubHtml } from "@/lib/resend";
import {
  trialEndingTemplate,
  trialStartedTemplate,
  welcomeTemplate,
  WELCOME_MAIL_FIXED_SUBJECT,
  TRIAL_STARTED_FIXED_SUBJECT,
  TRIAL_ENDING_FIXED_SUBJECT,
} from "./index";

const FLAG = "WELCOME_MAIL_FIXED_SUBJECT_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => delete process.env[FLAG]);
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const ORG = "株式会社テスト";
const XSS = `<a href="https://evil.example">click</a><img src=x onerror=alert(1)>'&`;
const BIDI = `表\u202E向き${ORG}`;
const LONG = `あ${"x".repeat(500)}社`;
const RAW_URL = "https://evil.example/phish";

/** main `b40aaa39` 時点の件名 + 本文（escapeHtml のみ。bidi は残る）。 */
function mainEraWelcome(orgName: string) {
  const org = escapeHtml(orgName);
  return {
    subject: `ようこそ — ${orgName} の AI社員 制御面`,
    html: renderStubHtml(
      "ようこそ",
      `<p>${org} 様の制御面を準備しました。</p>
       <p>次のステップ:</p>
       <ol>
         <li>はじめに チェックリストを開く</li>
         <li>最初の AI社員を雇う（職務を日本語で説明 → Draft → 社員証発行）</li>
         <li>Grok Bot 連携ステータスを確認する</li>
       </ol>`
    ),
  };
}

function mainEraTrialStarted(trialDays: number) {
  const days = escapeHtml(Number(trialDays));
  return {
    subject: `トライアル開始（${trialDays}日間）`,
    html: renderStubHtml(
      "トライアル開始",
      `<p>${days}日間、Business 相当の機能をお試しいただけます。</p>
       <p>AI社員の雇用・承認・監査・連携設定をご利用ください。</p>`
    ),
  };
}

function mainEraTrialEnding(orgName: string, daysLeft: number) {
  const org = escapeHtml(orgName);
  const days = escapeHtml(Number(daysLeft));
  return {
    subject: `トライアル終了まであと ${daysLeft} 日 — ${orgName}`,
    html: renderStubHtml(
      "トライアル終了のお知らせ",
      `<p>${org} 様のトライアルはあと <strong>${days} 日</strong> で終了します。</p>
       <p>継続する場合は「請求」から Stripe Checkout（カード / 銀行振込 customer_balance）へ進んでください。</p>`
    ),
  };
}

describe("WELCOME_MAIL_FIXED_SUBJECT_ENABLED flag", () => {
  test("defaults OFF", () => {
    expect(isWelcomeMailFixedSubjectEnabled()).toBe(false);
  });
  test("accepts true/1/on/enabled", () => {
    process.env[FLAG] = "true";
    expect(isWelcomeMailFixedSubjectEnabled()).toBe(true);
    process.env[FLAG] = "1";
    expect(isWelcomeMailFixedSubjectEnabled()).toBe(true);
    process.env[FLAG] = "on";
    expect(isWelcomeMailFixedSubjectEnabled()).toBe(true);
    process.env[FLAG] = "enabled";
    expect(isWelcomeMailFixedSubjectEnabled()).toBe(true);
  });
  test("false/off stay OFF", () => {
    process.env[FLAG] = "false";
    expect(isWelcomeMailFixedSubjectEnabled()).toBe(false);
    process.env[FLAG] = "off";
    expect(isWelcomeMailFixedSubjectEnabled()).toBe(false);
  });
});

describe("flag OFF: today's subjects", () => {
  test("welcome subject still embeds orgName", () => {
    const t = welcomeTemplate(ORG);
    expect(t.subject).toBe(`ようこそ — ${ORG} の AI社員 制御面`);
    expect(t.html).toContain("株式会社テスト");
  });
  test("trial_started subject still embeds trialDays", () => {
    const t = trialStartedTemplate(14);
    expect(t.subject).toBe("トライアル開始（14日間）");
    expect(t.html).toContain("14日間");
  });
  test("trial_ending subject still embeds orgName and daysLeft", () => {
    const t = trialEndingTemplate(ORG, 3);
    expect(t.subject).toBe(`トライアル終了まであと 3 日 — ${ORG}`);
    expect(t.html).toContain("株式会社テスト");
  });
  test("welcome body still HTML-escapes orgName and does not strip bidi", () => {
    const t = welcomeTemplate(XSS);
    expect(t.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(t.html).not.toContain(`<a href="https://evil.example"`);
    const bidi = welcomeTemplate(BIDI);
    expect(bidi.html).toContain("\u202E");
  });

  test("welcome / trial_started / trial_ending match main-era subject and html exactly", () => {
    for (const orgName of [ORG, XSS, BIDI, RAW_URL, LONG]) {
      expect(welcomeTemplate(orgName)).toEqual(mainEraWelcome(orgName));
      expect(trialEndingTemplate(orgName, 3)).toEqual(mainEraTrialEnding(orgName, 3));
    }
    expect(trialStartedTemplate(14)).toEqual(mainEraTrialStarted(14));
    expect(trialStartedTemplate(30)).toEqual(mainEraTrialStarted(30));
  });
});

describe("flag ON: fixed subjects; orgName only in sanitized body", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  test("welcome subject is fixed Staffpass copy; no orgName", () => {
    const t = welcomeTemplate(ORG);
    expect(t.subject).toBe(WELCOME_MAIL_FIXED_SUBJECT);
    expect(t.subject).toBe(`ようこそ — ${SERVICE_LABEL}`);
    expect(t.subject).not.toContain(ORG);
    expect(t.subject).not.toMatch(/[\r\n]/);
    expect(t.html).toContain("株式会社テスト");
  });

  test("welcome XSS / URL is escaped in the body and never linked", () => {
    const t = welcomeTemplate(XSS);
    expect(t.subject).toBe(WELCOME_MAIL_FIXED_SUBJECT);
    expect(t.subject).not.toContain("evil");
    expect(t.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(t.html).not.toContain(`<a href="https://evil.example"`);
    expect(t.html).not.toContain("<a href=");
    expect(t.html).not.toContain("mailto:");
    expect(t.html).not.toContain("<img");
  });

  test("welcome strips control, bidi, zero-width; caps length (same range as #403)", () => {
    expect(sanitizeInquiryPlainText("ab\u202Ecd", LP_INQUIRY_FIELD_MAX)).toBe("abcd");
    const t = welcomeTemplate(BIDI);
    expect(t.subject).not.toContain("\u202E");
    expect(t.html).not.toContain("\u202E");
    expect(t.html).toContain("表向き");
    const mixed = welcomeTemplate("x\u200By\u200Fz\u202Aw\u2066v\uFEFFu");
    expect(mixed.html).toContain("xyzwvu");
    const long = welcomeTemplate(LONG);
    expect(long.html).not.toContain("x".repeat(400));
    const dirty = welcomeTemplate(`ab\r\ncd\u0000ef`);
    expect(dirty.html).toContain("abcdef");
    expect(dirty.subject).not.toMatch(/[\r\n]/);
  });

  test("trial_started subject is fixed; days stay in the body", () => {
    const t = trialStartedTemplate(14);
    expect(t.subject).toBe(TRIAL_STARTED_FIXED_SUBJECT);
    expect(t.subject).not.toContain("14");
    expect(t.html).toContain("14日間");
  });

  test("trial_ending subject is fixed; orgName only in escaped body", () => {
    const t = trialEndingTemplate(XSS, 3);
    expect(t.subject).toBe(TRIAL_ENDING_FIXED_SUBJECT);
    expect(t.subject).not.toContain("evil");
    expect(t.subject).not.toContain("3");
    expect(t.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(t.html).not.toContain(`<a href="https://evil.example"`);
    expect(t.html).toContain("3");
  });

  test("raw URL is not turned into <a href> or mailto", () => {
    const t = welcomeTemplate(RAW_URL);
    expect(t.subject).toBe(WELCOME_MAIL_FIXED_SUBJECT);
    expect(t.subject).not.toContain("evil.example");
    expect(t.html).toContain("https://evil.example/phish");
    expect(t.html).not.toContain("<a href");
    expect(t.html).not.toContain("mailto:");
    const ending = trialEndingTemplate(RAW_URL, 3);
    expect(ending.subject).toBe(TRIAL_ENDING_FIXED_SUBJECT);
    expect(ending.html).toContain("https://evil.example/phish");
    expect(ending.html).not.toContain("<a href");
    expect(ending.html).not.toContain("mailto:");
  });

  test("trial_ending strips bidi / zero-width from the body", () => {
    const t = trialEndingTemplate(BIDI, 3);
    expect(t.subject).toBe(TRIAL_ENDING_FIXED_SUBJECT);
    expect(t.subject).not.toContain("\u202E");
    expect(t.html).not.toContain("\u202E");
    expect(t.html).toContain("表向き");
    const mixed = trialEndingTemplate("x\u200By\u200Fz\u202Aw\u2066v\uFEFFu", 3);
    expect(mixed.html).toContain("xyzwvu");
    expect(mixed.html).not.toContain("\u200B");
  });
});

describe("配線", () => {
  test(".env.example にフラグがある（既定はコメント / OFF）", () => {
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    expect(env).toContain("WELCOME_MAIL_FIXED_SUBJECT_ENABLED");
    expect(env).not.toMatch(/^WELCOME_MAIL_FIXED_SUBJECT_ENABLED=true/m);
  });
});
